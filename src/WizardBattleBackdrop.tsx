// src/WizardBattleBackdrop.tsx
//
// Page art as a flat, faded backdrop layer. Used by the rules, boosters,
// profile and ladder pages. Its own module because App already imports
// Boosters, so Boosters cannot import from App.
//
// Drop it into a `position: fixed` backdrop right after that backdrop's solid
// base, so particles / glints still render over it. Low opacity plus a dark
// scrim keep body text readable on top.

export const WIZARD_BATTLE_BG = '/wizard-battle-bg.png';
export const DRAGON_WIZARD_BG = '/dragon-wizard-bg.png';

export function ArtBackdrop({ src }: { src: string }) {
  return (
    <>
      <img src={src} alt="" draggable={false} style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center',
        opacity: 0.22, filter: 'saturate(0.85)', userSelect: 'none',
      }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(6,6,13,0.35), rgba(6,6,13,0.6))' }} />
    </>
  );
}
