# Branding Assets

This folder holds every image referenced by `README.md` and the launcher. The
files are **gitignored by default** (add them once; they won't bloat clones) —
but for a public repo you'll want to commit them so the README renders.

## Required images (drop these in)

| File                              | Used in                                  | Specs                                      | How to get it                                                                 |
| --------------------------------- | ---------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `logo.png`                        | Source for everything below              | Square, ≥512×512, transparent background    | Your logo (the PNG you mentioned). Drop it here, then run `build-assets.ps1`. |
| `logo.ico`                        | `Launch-DAFE-Career-OS.exe` icon         | 16–256px multi-size (auto-generated)       | `powershell -ExecutionPolicy Bypass -File branding\build-assets.ps1`          |
| `favicon.ico`                     | Docs site / browser tab                  | 16–48px (auto-generated)                   | Same script.                                                                  |
| `logo-256.png`                    | README header / social card              | 512×512 (auto-generated)                   | Same script.                                                                  |
| `hero-banner.png`                 | README top banner                        | 1600×500 or 1200×400, brand colors         | Make from `logo-256.png` + tagline in a tool like Canva/Figma.                |
| `need-a-job-now-banner.png`       | "I Need A Job Now!" section              | 1400×500, bold "I NEED A JOB NOW!" text    | Design with your logo + fire/urgency motif.                                   |
| `demo.gif`                        | README demo                              | ~15–30s screen capture, ≤5MB               | Record `need-a-job-now.mjs` or dashboard in action (ShareX, OBS, Kap).        |
| `setup-screenshot.png`            | Quick Start onboarding                   | 1200×750, terminal or chat onboarding      | Screenshot the first-run flow.                                                |
| `dashboard-screenshot.png`        | Dashboard TUI section                    | 1400×800, the Go TUI                        | Screenshot `npm run serve:dashboard`.                                         |

## Optional / nice-to-have

| File                       | Used in                | Notes                                         |
| -------------------------- | ---------------------- | --------------------------------------------- |
| `og-image.jpg`             | Social share preview   | 1200×630, logo + project name.               |
| `vision-banner.jpg`        | Docs/about page        | If you write a vision page.                  |
| `roadmap-phases.jpg`       | Docs/roadmap           | If you publish a roadmap diagram.            |
| `press/*.svg`              | README "as featured in"| Only if you have press logos (WIRED, etc.).  |

## Build the icon + exe

1. Put your `logo.png` in this folder.
2. Generate the ICO/PNG set:
   ```powershell
   powershell -ExecutionPolicy Bypass -File branding\build-assets.ps1
   ```
3. Build the one-click `.exe` (Windows has `iexpress` built in):
   ```powershell
   iexpress /N /Q build-launcher.sed
   ```
   This produces `Launch-DAFE-Career-OS.exe` in the project root, with your
   `logo.ico` embedded. Double-click it → menu → pick "I Need A Job Now!".

## Color palette (suggested)

- Background: `#0B0E14` (near-black) or white for light mode
- Accent: `#2EA44F` (green, "go") — matches the README badges
- Urgency (I Need A Job Now): `#FF4B4B` / `#FFB020` (fire/amber)

Keep the logo legible at 16×16 (favicon/exe). Transparent PNG → ICO preserves
the transparency.
