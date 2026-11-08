// programs/master_wager/src/lib.rs
//
// Memetic Masters — $MASTER token wager escrow.
//
// Flow:
//   1. `initialize(config)`    — admin sets oracle + master_mint + burn_bps.
//   2. `create_match(...)`     — creator deposits N $MASTER into a per-match PDA vault.
//   3. `join_match(...)`       — opponent deposits matching N $MASTER.
//   4. `settle_match(winner)`  — oracle signs; burns burn_bps of pot; sends rest to winner.
//   5. `settle_draw()`         — oracle signs a draw; refunds both deposits, no burn.
//   6. `cancel_match()`        — if opponent never joined within cancel_timeout, creator
//                                can reclaim their full deposit.
//   7. `expire_match()`        — permissionless safety valve: after SETTLE_TIMEOUT an Active
//                                match with no settle refunds both players.
//
// Authority model: the `config.oracle` keypair (held server-side) is the only signer
// that can call settle_match / settle_draw. Players sign their own create/join/cancel
// calls with their own wallets (Phantom). `initialize` is gated to the program's
// upgrade authority (contracts-15) so it cannot be front-run after deploy.
//
// The vault is a token account whose authority PDA == match account PDA, so the
// program signs every payout / burn with seeds = [b"match", match_id].
//
// IMPORTANT INVARIANTS:
//   * burn_bps is bounded 0..=2_000 (max 20%) — admin can't grief users. It is snapshotted
//     onto each Match at create_match (contracts-17) so a later set_config can't change the
//     rate a live match settles at.
//   * wager_amount must equal config.min_wager..=u64::MAX/4 to avoid arithmetic overflow
//     when computing pot.
//   * settle/cancel/draw/expire are idempotent via the `MatchState` enum — re-running fails.
//   * winner must be either creator or opponent — anything else is rejected.
//   * on settle/draw/cancel/expire the Match account is closed and the vault token account is
//     CPI-closed, returning all rent to the creator (contracts-16) — no stuck Active matches.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, Token, TokenAccount, Transfer};
use crate::program::MasterWager;

declare_id!("9JnG7C3uBVnMgx5tSAxSb9ccSuwCC4LkmyV26goXe1pC");

pub const CONFIG_SEED:      &[u8] = b"config";
pub const MATCH_SEED:       &[u8] = b"match";
pub const VAULT_SEED:       &[u8] = b"vault";

pub const MAX_BURN_BPS:     u16   = 2_000;        // 20 %
pub const BPS_DENOM:        u64   = 10_000;
pub const DEFAULT_TIMEOUT:  i64   = 15 * 60;      // 15 minutes
/// Permissionless expire window for a stuck Active match (contracts-14).
pub const SETTLE_TIMEOUT:   i64   = 24 * 60 * 60; // 24 hours

#[program]
pub mod master_wager {
    use super::*;

    /// One-time program initialization. Gated to the program's upgrade authority so a
    /// watcher cannot front-run init and install their own oracle/admin (contracts-15).
    pub fn initialize(
        ctx: Context<Initialize>,
        oracle: Pubkey,
        burn_bps: u16,
        cancel_timeout_secs: i64,
        min_wager: u64,
    ) -> Result<()> {
        require!(burn_bps <= MAX_BURN_BPS, WagerError::BurnBpsTooHigh);
        require!(cancel_timeout_secs > 0 && cancel_timeout_secs <= 86_400, WagerError::BadTimeout);
        let cfg = &mut ctx.accounts.config;
        cfg.admin               = ctx.accounts.admin.key();
        cfg.oracle              = oracle;
        cfg.master_mint         = ctx.accounts.master_mint.key();
        cfg.burn_bps            = burn_bps;
        cfg.cancel_timeout_secs = cancel_timeout_secs;
        cfg.min_wager           = min_wager;
        cfg.bump                = ctx.bumps.config;
        emit!(ConfigUpdated { admin: cfg.admin, oracle: cfg.oracle, burn_bps, cancel_timeout_secs, min_wager });
        Ok(())
    }

    /// Admin rotates oracle / changes economic parameters.
    pub fn set_config(
        ctx: Context<SetConfig>,
        new_oracle: Option<Pubkey>,
        new_burn_bps: Option<u16>,
        new_cancel_timeout_secs: Option<i64>,
        new_min_wager: Option<u64>,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        if let Some(o) = new_oracle { cfg.oracle = o; }
        if let Some(b) = new_burn_bps {
            require!(b <= MAX_BURN_BPS, WagerError::BurnBpsTooHigh);
            cfg.burn_bps = b;
        }
        if let Some(t) = new_cancel_timeout_secs {
            require!(t > 0 && t <= 86_400, WagerError::BadTimeout);
            cfg.cancel_timeout_secs = t;
        }
        if let Some(m) = new_min_wager { cfg.min_wager = m; }
        emit!(ConfigUpdated {
            admin: cfg.admin, oracle: cfg.oracle,
            burn_bps: cfg.burn_bps, cancel_timeout_secs: cfg.cancel_timeout_secs,
            min_wager: cfg.min_wager,
        });
        Ok(())
    }

    /// Creator opens a match and deposits the wager.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: [u8; 32],
        wager_amount: u64,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(wager_amount >= cfg.min_wager, WagerError::WagerTooSmall);
        // Bound the wager so 2× pot never overflows.
        require!(wager_amount <= u64::MAX / 4, WagerError::WagerTooLarge);
        require_keys_eq!(ctx.accounts.master_mint.key(), cfg.master_mint, WagerError::WrongMint);
        require_keys_eq!(ctx.accounts.vault.mint, cfg.master_mint, WagerError::WrongMint);
        require_keys_eq!(ctx.accounts.creator_ata.mint, cfg.master_mint, WagerError::WrongMint);
        require_keys_eq!(ctx.accounts.creator_ata.owner, ctx.accounts.creator.key(), WagerError::AtaOwnerMismatch);

        let m = &mut ctx.accounts.match_account;
        m.match_id     = match_id;
        m.creator      = ctx.accounts.creator.key();
        m.opponent     = Pubkey::default();
        m.wager_amount = wager_amount;
        m.mint         = cfg.master_mint;
        m.state        = MatchState::Open as u8;
        m.winner       = Pubkey::default();
        m.created_at   = Clock::get()?.unix_timestamp;
        m.config       = cfg.key();
        m.burn_bps     = cfg.burn_bps; // snapshot the rate (contracts-17)
        m.bump         = ctx.bumps.match_account;
        m.vault_bump   = ctx.bumps.vault;

        // Pull creator's deposit into the vault.
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.creator_ata.to_account_info(),
                to:        ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        );
        token::transfer(cpi, wager_amount)?;

        emit!(MatchCreated { match_id, creator: m.creator, wager_amount, created_at: m.created_at });
        Ok(())
    }

    /// Opponent joins an open match and deposits matching wager.
    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        require!(m.state == MatchState::Open as u8, WagerError::WrongState);
        require_keys_neq!(m.creator, ctx.accounts.opponent.key(), WagerError::CannotJoinOwnMatch);
        require_keys_eq!(ctx.accounts.opponent_ata.mint, m.mint, WagerError::WrongMint);
        require_keys_eq!(ctx.accounts.opponent_ata.owner, ctx.accounts.opponent.key(), WagerError::AtaOwnerMismatch);

        // Pull opponent's deposit into the vault.
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.opponent_ata.to_account_info(),
                to:        ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.opponent.to_account_info(),
            },
        );
        token::transfer(cpi, m.wager_amount)?;

        m.opponent = ctx.accounts.opponent.key();
        m.state    = MatchState::Active as u8;
        emit!(MatchJoined { match_id: m.match_id, opponent: m.opponent });
        Ok(())
    }

    /// Oracle settles: burns burn_bps of pot, sends rest to winner, closes the accounts.
    pub fn settle_match(ctx: Context<SettleMatch>, winner: Pubkey) -> Result<()> {
        // Snapshot every AccountInfo we'll hand to CPI BEFORE taking a &mut borrow
        // on match_account (Anchor's Account<T> derefs through the same AccountInfo).
        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let master_mint_ai   = ctx.accounts.master_mint.to_account_info();
        let vault_ai         = ctx.accounts.vault.to_account_info();
        let winner_ata_ai    = ctx.accounts.winner_ata.to_account_info();
        let creator_ai       = ctx.accounts.creator.to_account_info();
        let match_account_ai = ctx.accounts.match_account.to_account_info();

        let cfg = &ctx.accounts.config;
        let m = &mut ctx.accounts.match_account;
        require!(m.state == MatchState::Active as u8, WagerError::WrongState);
        require_keys_eq!(ctx.accounts.oracle.key(), cfg.oracle, WagerError::NotOracle);
        require!(winner == m.creator || winner == m.opponent, WagerError::InvalidWinner);
        require_keys_eq!(ctx.accounts.winner_ata.owner, winner, WagerError::AtaOwnerMismatch);
        require_keys_eq!(ctx.accounts.winner_ata.mint, m.mint, WagerError::WrongMint);
        require_keys_eq!(ctx.accounts.creator.key(), m.creator, WagerError::NotCreator);

        let pot       = m.wager_amount.checked_mul(2).ok_or(WagerError::MathOverflow)?;
        // Use the rate snapshotted on the match, not the live config (contracts-17).
        let burn_amt  = (pot as u128 * m.burn_bps as u128 / BPS_DENOM as u128) as u64;
        let payout    = pot.checked_sub(burn_amt).ok_or(WagerError::MathOverflow)?;

        let match_id   = m.match_id;
        let bump       = m.bump;
        let signer_seeds: &[&[u8]] = &[MATCH_SEED, match_id.as_ref(), &[bump]];
        let signers = &[signer_seeds];

        if burn_amt > 0 {
            let cpi_burn = CpiContext::new_with_signer(
                token_program_ai.clone(),
                Burn {
                    mint:      master_mint_ai.clone(),
                    from:      vault_ai.clone(),
                    authority: match_account_ai.clone(),
                },
                signers,
            );
            token::burn(cpi_burn, burn_amt)?;
        }

        if payout > 0 {
            let cpi_xfer = CpiContext::new_with_signer(
                token_program_ai.clone(),
                Transfer {
                    from:      vault_ai.clone(),
                    to:        winner_ata_ai,
                    authority: match_account_ai.clone(),
                },
                signers,
            );
            token::transfer(cpi_xfer, payout)?;
        }

        // Vault is now empty; close it and return its rent to the creator (contracts-16).
        close_vault(token_program_ai, vault_ai, creator_ai, match_account_ai, signers)?;

        m.state  = MatchState::Settled as u8;
        m.winner = winner;
        emit!(MatchSettled { match_id, winner, pot, burned: burn_amt, payout });
        Ok(())
        // match_account is closed via `close = creator` on the context.
    }

    /// Oracle declares a draw: refund each player their own deposit, no burn, close accounts.
    pub fn settle_draw(ctx: Context<SettleOrExpire>) -> Result<()> {
        settle_or_expire(ctx, true)
    }

    /// Permissionless: after SETTLE_TIMEOUT an Active match that was never settled refunds
    /// both players so stakes are never locked if the oracle disappears (contracts-14).
    pub fn expire_match(ctx: Context<SettleOrExpire>) -> Result<()> {
        settle_or_expire(ctx, false)
    }

    /// Creator reclaims their deposit if no opponent joined within cancel_timeout_secs.
    pub fn cancel_match(ctx: Context<CancelMatch>) -> Result<()> {
        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let vault_ai         = ctx.accounts.vault.to_account_info();
        let creator_ata_ai   = ctx.accounts.creator_ata.to_account_info();
        let creator_ai       = ctx.accounts.creator.to_account_info();
        let match_account_ai = ctx.accounts.match_account.to_account_info();

        let cfg = &ctx.accounts.config;
        let m = &mut ctx.accounts.match_account;
        require!(m.state == MatchState::Open as u8, WagerError::WrongState);
        require_keys_eq!(ctx.accounts.creator.key(), m.creator, WagerError::NotCreator);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= m.created_at + cfg.cancel_timeout_secs, WagerError::CancelTooEarly);
        require_keys_eq!(ctx.accounts.creator_ata.owner, m.creator, WagerError::AtaOwnerMismatch);
        require_keys_eq!(ctx.accounts.creator_ata.mint, m.mint, WagerError::WrongMint);

        let match_id = m.match_id;
        let bump     = m.bump;
        let signer_seeds: &[&[u8]] = &[MATCH_SEED, match_id.as_ref(), &[bump]];
        let signers = &[signer_seeds];

        let cpi = CpiContext::new_with_signer(
            token_program_ai.clone(),
            Transfer {
                from:      vault_ai.clone(),
                to:        creator_ata_ai,
                authority: match_account_ai.clone(),
            },
            signers,
        );
        token::transfer(cpi, m.wager_amount)?;

        close_vault(token_program_ai, vault_ai, creator_ai, match_account_ai, signers)?;

        m.state = MatchState::Cancelled as u8;
        emit!(MatchCancelled { match_id, refund: m.wager_amount });
        Ok(())
    }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/// Draw (oracle-gated) or expire (permissionless + timeout) of an Active match:
/// refund both players their own deposit and close the accounts.
fn settle_or_expire(ctx: Context<SettleOrExpire>, oracle_gated: bool) -> Result<()> {
    let token_program_ai = ctx.accounts.token_program.to_account_info();
    let vault_ai         = ctx.accounts.vault.to_account_info();
    let creator_ata_ai   = ctx.accounts.creator_ata.to_account_info();
    let opponent_ata_ai  = ctx.accounts.opponent_ata.to_account_info();
    let creator_ai       = ctx.accounts.creator.to_account_info();
    let match_account_ai = ctx.accounts.match_account.to_account_info();

    let cfg = &ctx.accounts.config;
    let m = &mut ctx.accounts.match_account;
    require!(m.state == MatchState::Active as u8, WagerError::WrongState);
    require_keys_eq!(ctx.accounts.creator.key(), m.creator, WagerError::NotCreator);
    require_keys_eq!(ctx.accounts.creator_ata.owner, m.creator, WagerError::AtaOwnerMismatch);
    require_keys_eq!(ctx.accounts.opponent_ata.owner, m.opponent, WagerError::AtaOwnerMismatch);
    require_keys_eq!(ctx.accounts.creator_ata.mint, m.mint, WagerError::WrongMint);
    require_keys_eq!(ctx.accounts.opponent_ata.mint, m.mint, WagerError::WrongMint);

    if oracle_gated {
        require_keys_eq!(ctx.accounts.caller.key(), cfg.oracle, WagerError::NotOracle);
    } else {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= m.created_at + SETTLE_TIMEOUT, WagerError::CancelTooEarly);
    }

    let refund   = m.wager_amount;
    let match_id = m.match_id;
    let bump     = m.bump;
    let signer_seeds: &[&[u8]] = &[MATCH_SEED, match_id.as_ref(), &[bump]];
    let signers = &[signer_seeds];

    // Refund creator.
    token::transfer(
        CpiContext::new_with_signer(
            token_program_ai.clone(),
            Transfer { from: vault_ai.clone(), to: creator_ata_ai, authority: match_account_ai.clone() },
            signers,
        ),
        refund,
    )?;
    // Refund opponent.
    token::transfer(
        CpiContext::new_with_signer(
            token_program_ai.clone(),
            Transfer { from: vault_ai.clone(), to: opponent_ata_ai, authority: match_account_ai.clone() },
            signers,
        ),
        refund,
    )?;

    close_vault(token_program_ai, vault_ai, creator_ai, match_account_ai, signers)?;

    m.state = MatchState::Cancelled as u8;
    if oracle_gated {
        emit!(MatchDrawn { match_id, refund_each: refund });
    } else {
        emit!(MatchExpired { match_id, refund_each: refund });
    }
    Ok(())
}

/// CPI-close the (now empty) vault token account, returning its rent lamports to `dest`.
fn close_vault<'info>(
    token_program_ai: AccountInfo<'info>,
    vault_ai: AccountInfo<'info>,
    dest_ai: AccountInfo<'info>,
    match_account_ai: AccountInfo<'info>,
    signers: &[&[&[u8]]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        token_program_ai,
        CloseAccount {
            account:     vault_ai,
            destination: dest_ai,
            authority:   match_account_ai,
        },
        signers,
    ))
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[account]
pub struct Config {
    pub admin:               Pubkey,
    pub oracle:              Pubkey,
    pub master_mint:         Pubkey,
    pub burn_bps:            u16,
    pub cancel_timeout_secs: i64,
    pub min_wager:           u64,
    pub bump:                u8,
}
impl Config { pub const SIZE: usize = 32 + 32 + 32 + 2 + 8 + 8 + 1; }

#[account]
pub struct Match {
    pub match_id:     [u8; 32],
    pub creator:      Pubkey,
    pub opponent:     Pubkey,
    pub wager_amount: u64,
    pub mint:         Pubkey,
    pub state:        u8,
    pub winner:       Pubkey,
    pub created_at:   i64,
    pub config:       Pubkey,
    pub burn_bps:     u16,
    pub bump:         u8,
    pub vault_bump:   u8,
}
impl Match { pub const SIZE: usize = 32 + 32 + 32 + 8 + 32 + 1 + 32 + 8 + 32 + 2 + 1 + 1; }

#[repr(u8)]
pub enum MatchState {
    Open      = 0,
    Active    = 1,
    Settled   = 2,
    Cancelled = 3,
}

// ── Contexts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::SIZE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    pub master_mint: Account<'info, Mint>,
    // Gate initialize to the program's upgrade authority so init cannot be front-run
    // after deploy (contracts-15).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ WagerError::NotAdmin)]
    pub program: Program<'info, MasterWager>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ WagerError::NotAdmin)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ WagerError::NotAdmin,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct CreateMatch<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = creator,
        space = 8 + Match::SIZE,
        seeds = [MATCH_SEED, match_id.as_ref()],
        bump,
    )]
    pub match_account: Account<'info, Match>,
    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, match_id.as_ref()],
        bump,
        token::mint      = master_mint,
        token::authority = match_account,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub master_mint: Account<'info, Mint>,
    #[account(mut)]
    pub creator_ata: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program:  Program<'info, Token>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)] pub opponent: Signer<'info>,
    #[account(
        mut,
        seeds = [MATCH_SEED, match_account.match_id.as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, Match>,
    #[account(
        mut,
        seeds = [VAULT_SEED, match_account.match_id.as_ref()],
        bump = match_account.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub opponent_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = creator,
        seeds = [MATCH_SEED, match_account.match_id.as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, Match>,
    #[account(
        mut,
        seeds = [VAULT_SEED, match_account.match_id.as_ref()],
        bump = match_account.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.master_mint @ WagerError::WrongMint)]
    pub master_mint: Account<'info, Mint>,
    #[account(mut)]
    pub winner_ata: Account<'info, TokenAccount>,
    /// Rent recipient on close; must be the match creator.
    #[account(mut, address = match_account.creator @ WagerError::NotCreator)]
    pub creator: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Shared context for `settle_draw` (oracle) and `expire_match` (permissionless + timeout).
#[derive(Accounts)]
pub struct SettleOrExpire<'info> {
    /// Oracle for a draw; any fee payer for a permissionless expire.
    pub caller: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = creator,
        seeds = [MATCH_SEED, match_account.match_id.as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, Match>,
    #[account(
        mut,
        seeds = [VAULT_SEED, match_account.match_id.as_ref()],
        bump = match_account.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub creator_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub opponent_ata: Account<'info, TokenAccount>,
    /// Rent recipient on close; must be the match creator.
    #[account(mut, address = match_account.creator @ WagerError::NotCreator)]
    pub creator: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelMatch<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = creator,
        seeds = [MATCH_SEED, match_account.match_id.as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, Match>,
    #[account(
        mut,
        seeds = [VAULT_SEED, match_account.match_id.as_ref()],
        bump = match_account.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub creator_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ── Events ──────────────────────────────────────────────────────────────────

#[event] pub struct ConfigUpdated { pub admin: Pubkey, pub oracle: Pubkey, pub burn_bps: u16, pub cancel_timeout_secs: i64, pub min_wager: u64 }
#[event] pub struct MatchCreated  { pub match_id: [u8; 32], pub creator: Pubkey, pub wager_amount: u64, pub created_at: i64 }
#[event] pub struct MatchJoined   { pub match_id: [u8; 32], pub opponent: Pubkey }
#[event] pub struct MatchSettled  { pub match_id: [u8; 32], pub winner: Pubkey, pub pot: u64, pub burned: u64, pub payout: u64 }
#[event] pub struct MatchDrawn    { pub match_id: [u8; 32], pub refund_each: u64 }
#[event] pub struct MatchExpired  { pub match_id: [u8; 32], pub refund_each: u64 }
#[event] pub struct MatchCancelled { pub match_id: [u8; 32], pub refund: u64 }

// ── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum WagerError {
    #[msg("Burn basis points exceeds maximum (20%).")] BurnBpsTooHigh,
    #[msg("Cancel timeout out of bounds.")]            BadTimeout,
    #[msg("Wager amount below minimum.")]              WagerTooSmall,
    #[msg("Wager amount too large.")]                  WagerTooLarge,
    #[msg("Token mint does not match config.")]        WrongMint,
    #[msg("Token account owner mismatch.")]            AtaOwnerMismatch,
    #[msg("Match is not in the required state.")]      WrongState,
    #[msg("Creator cannot join their own match.")]     CannotJoinOwnMatch,
    #[msg("Caller is not the configured oracle.")]     NotOracle,
    #[msg("Caller is not the program admin.")]         NotAdmin,
    #[msg("Caller is not the match creator.")]         NotCreator,
    #[msg("Winner must be creator or opponent.")]      InvalidWinner,
    #[msg("Cannot cancel before timeout elapses.")]    CancelTooEarly,
    #[msg("Arithmetic overflow.")]                     MathOverflow,
}
