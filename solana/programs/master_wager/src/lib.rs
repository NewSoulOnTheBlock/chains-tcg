// programs/master_wager/src/lib.rs
//
// Memetic Masters — $MASTER token wager escrow.
//
// Flow:
//   1. `initialize(config)`    — admin sets oracle + master_mint + burn_bps.
//   2. `create_match(...)`     — creator deposits N $MASTER into a per-match PDA vault.
//   3. `join_match(...)`       — opponent deposits matching N $MASTER.
//   4. `settle_match(winner)`  — oracle signs; burns burn_bps of pot; sends rest to winner.
//   5. `cancel_match()`        — if opponent never joined within cancel_timeout, creator
//                                can reclaim their full deposit.
//
// Authority model: the `config.oracle` keypair (held server-side) is the only signer
// that can call settle_match. Players sign their own create/join/cancel calls with
// their own wallets (Phantom).
//
// The vault is a token account whose authority PDA == match account PDA, so the
// program signs every payout / burn with seeds = [b"match", match_id].
//
// IMPORTANT INVARIANTS:
//   * burn_bps is bounded 0..=2_000 (max 20%) — admin can't grief users.
//   * wager_amount must equal config.min_wager..=u64::MAX/4 to avoid arithmetic overflow
//     when computing pot.
//   * settle/cancel are idempotent via the `MatchState` enum — re-running fails cleanly.
//   * winner must be either creator or opponent — anything else is rejected.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

declare_id!("9JnG7C3uBVnMgx5tSAxSb9ccSuwCC4LkmyV26goXe1pC");

pub const CONFIG_SEED:      &[u8] = b"config";
pub const MATCH_SEED:       &[u8] = b"match";
pub const VAULT_SEED:       &[u8] = b"vault";

pub const MAX_BURN_BPS:     u16   = 2_000;     // 20 %
pub const BPS_DENOM:        u64   = 10_000;
pub const DEFAULT_TIMEOUT:  i64   = 15 * 60;   // 15 minutes

#[program]
pub mod master_wager {
    use super::*;

    /// One-time program initialization. Admin pays for the Config PDA.
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
        m.created_at   = Clock::get()?.unix_timestamp;
        m.config       = cfg.key();
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

    /// Oracle settles: burns burn_bps of pot, sends rest to winner.
    pub fn settle_match(ctx: Context<SettleMatch>, winner: Pubkey) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        let cfg = &ctx.accounts.config;
        require!(m.state == MatchState::Active as u8, WagerError::WrongState);
        require_keys_eq!(ctx.accounts.oracle.key(), cfg.oracle, WagerError::NotOracle);
        require!(winner == m.creator || winner == m.opponent, WagerError::InvalidWinner);
        require_keys_eq!(ctx.accounts.winner_ata.owner, winner, WagerError::AtaOwnerMismatch);
        require_keys_eq!(ctx.accounts.winner_ata.mint, m.mint, WagerError::WrongMint);

        let pot       = m.wager_amount.checked_mul(2).ok_or(WagerError::MathOverflow)?;
        let burn_amt  = (pot as u128 * cfg.burn_bps as u128 / BPS_DENOM as u128) as u64;
        let payout    = pot.checked_sub(burn_amt).ok_or(WagerError::MathOverflow)?;

        let match_id   = m.match_id;
        let bump       = m.bump;
        let signer_seeds: &[&[u8]] = &[MATCH_SEED, match_id.as_ref(), &[bump]];
        let signers = &[signer_seeds];

        if burn_amt > 0 {
            let cpi_burn = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint:      ctx.accounts.master_mint.to_account_info(),
                    from:      ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.match_account.to_account_info(),
                },
                signers,
            );
            token::burn(cpi_burn, burn_amt)?;
        }

        if payout > 0 {
            let cpi_xfer = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.winner_ata.to_account_info(),
                    authority: ctx.accounts.match_account.to_account_info(),
                },
                signers,
            );
            token::transfer(cpi_xfer, payout)?;
        }

        m.state  = MatchState::Settled as u8;
        m.winner = winner;
        emit!(MatchSettled { match_id, winner, pot, burned: burn_amt, payout });
        Ok(())
    }

    /// Creator reclaims their deposit if no opponent joined within cancel_timeout_secs.
    pub fn cancel_match(ctx: Context<CancelMatch>) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        let cfg = &ctx.accounts.config;
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
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.vault.to_account_info(),
                to:        ctx.accounts.creator_ata.to_account_info(),
                authority: ctx.accounts.match_account.to_account_info(),
            },
            signers,
        );
        token::transfer(cpi, m.wager_amount)?;

        m.state = MatchState::Cancelled as u8;
        emit!(MatchCancelled { match_id, refund: m.wager_amount });
        Ok(())
    }
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
    pub bump:         u8,
    pub vault_bump:   u8,
}
impl Match { pub const SIZE: usize = 32 + 32 + 32 + 8 + 32 + 1 + 32 + 8 + 32 + 1 + 1; }

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
