Resolves: https://github.com/ToufiqSenpai/personal-store/issues/2

# StyleX + UI SDK + TanStack Start / Vite 8 / React 19 / RSC — compatibility research

## Verdict (short answer)

**Yes, with one caveat.** StyleX 0.19.2 and UI SDK 0.1.0-beta.16 are mutually compatible and both fit the repo's React 19 / RSC stack. The supported integration path is `@stylexjs/unplugin`'s Vite adapter, **not** a dedicated `@stylexjs/vite-plugin` (no such package exists — see version table). StyleX needs no app-level Babel config and no SWC plugin: the unplugin runs `@stylexjs/babel-plugin` internally. The one unverified piece is `@stylexjs/unplugin`'s pinned `unplugin@^2.3.11` adapter running on Vite 8's Rolldown; treat that as a required smoke test, with the fallback in the last section.

---

## 1. Packages and versions (npm registry metadata, checked 2026-11-24)

| Package | Version | Evidence / role |
|---|---|---|
| `@stylexjs/stylex` | **0.19.2** (latest) | Runtime; all StyleX use requires it. Source: https://registry.npmjs.org/@stylexjs/stylex/latest ; https://stylexjs.com/docs/learn/installation |
| `@stylexjs/babel-plugin` | **0.19.2** (latest) | Compiler; a dependency of `@stylexjs/unplugin`, so no direct install needed for the Vite path. Source: https://registry.npmjs.org/@stylexjs/babel-plugin/latest ; https://raw.githubusercontent.com/meta/stylex/main/packages/@stylexjs/unplugin/README.md |
| `@stylexjs/unplugin` | **0.19.2** (latest) | The official Vite/Rollup/Rolldown adapter (`./vite` export). Peer dep: `unplugin: ^2.3.11`. Source: https://registry.npmjs.org/@stylexjs/unplugin/latest |
| `unplugin` | 2.3.10 is `latest-v2`; 3.7.0 is `latest` (its devDependency is `vite ^8.3.5`). The StyleX adapter's peer range resolves **2.x**, which was developed against Vite 7 (`devDependencies.vite: ^7.1.3`). | Source: https://registry.npmjs.org/unplugin ; https://registry.npmjs.org/unplugin/2.3.10 ; https://registry.npmjs.org/unplugin/latest |
| `@stylexjs/esbuild-plugin` | 0.11.1, **deprecated** ("Package no longer supported") | Do not use. Source: https://registry.npmjs.org/@stylexjs/esbuild-plugin/latest |
| `@stylexjs/vite-plugin` | **404 on npm registry** — package does not exist | Source: https://registry.npmjs.org/@stylexjs/vite-plugin/latest (HTTP 404) |
| `@ui-sdk/core` | **0.1.0-beta.16** (latest); ships `./web.css` export, Apache-2.0 | Source: https://registry.npmjs.org/@ui-sdk/core/latest |
| `@ui-sdk/react` | **0.1.0-beta.16** (latest); peers `react >=19`, `react-dom >=19`, `@ui-sdk/core ^0.1.0-beta.16`, `@types/react >=19.2.10` (optional) | Repo has React 19.3.1 and @types/react 19.3.0 → satisfies. Source: https://registry.npmjs.org/@ui-sdk/react/latest ; local `package.json` lines 46, 57 |
| `@vitejs/plugin-react` | 6.0.3 already installed; Vite 8 ships v6, which uses Oxc and no longer depends on Babel | Source: local `package.json` line 59; https://vite.dev/blog/announcing-vite8 |

**Compatibility risk to verify:** Vite 8 replaced esbuild/Rollup with Rolldown/Oxc but states "full plugin compatibility" for existing Vite plugins (https://vite.dev/blog/announcing-vite8). `@stylexjs/unplugin` has a `./rolldown` export and its `unplugin` peer declares `rolldown: *` as optional (https://registry.npmjs.org/@stylexjs/unplugin/latest ; https://registry.npmjs.org/unplugin/latest), which is encouraging; however the resolved `unplugin@2.3.10` was built/tested against Vite 7, not 8. No primary source asserts the 0.19.2 + Vite 8 combination is tested. Smoke-test `bun run dev:vite` and a production build before locking the spec.

---

## 2. Minimal configuration for this repo

### 2.1 Install

```
bun add @stylexjs/stylex @ui-sdk/core @ui-sdk/react
bun add -d @stylexjs/unplugin
```

(`unplugin` 2.x is installed automatically as the peer. Sources: registry metadata above; https://ui-sdk.dev/docs/react/llms.txt "npm install @ui-sdk/react @ui-sdk/core".)

### 2.2 Vite plugin — no Babel/SWC config file needed

StyleX's compiler is *inside* `@stylexjs/unplugin` (its dependencies include `@babel/core` and `@stylexjs/babel-plugin`, https://registry.npmjs.org/@stylexjs/unplugin/latest). Do **not** add a `.babelrc` or an SWC plugin; the official Vite guide only requires `stylex.vite()` in `vite.config.ts` (https://stylexjs.com/docs/learn/installation/vite/vite-react). The official React Router RSC guide puts `stylex.vite()` **first**, before React and RSC plugins, and says this preserves Fast Refresh (https://stylexjs.com/docs/learn/installation/vite/react-router); the Vite+RSC guide shows `rsc()` first but still requires `stylex.vite()` to run for every environment (https://stylexjs.com/docs/learn/installation/vite/vite-rsc). Follow the React Router ordering first and swap only if the RSC plugin regresses.

Proposed change to local `vite.config.ts` (current file lines 1–23):

```ts
import stylex from '@stylexjs/unplugin'
// ...existing imports...

export default defineConfig(
  withPayload(
    ({ pluginOptions }) => ({
      plugins: [
        stylex.vite({
          useCSSLayers: false, // keep StyleX unlayered so it beats UI SDK's @layer ui-sdk
          aliases: { '@/*': [path.join(__dirname, 'src/*')] }, // matches resolve.alias in this file
          unstable_moduleResolution: { type: 'commonJS' }, // REQUIRED for defineVars/createTheme
          devPersistToDisk: true, // share collected rules across RSC/SSR/client dev environments
          cssInjectionTarget: (fileName) => fileName.includes('styles.css'),
        }),
        rsc(pluginOptions.rsc),
        tanstackStart({ /* unchanged */ }),
        viteReact(pluginOptions.react),
      ],
      // ...resolve, server unchanged...
    }),
    { payloadConfigPath: /* unchanged */ },
  ),
)
```

Rationale for each option:
- `useCSSLayers: false`: UI SDK declares `@layer ui-sdk;` so application CSS wins; unlayered StyleX output also wins over that layer. If `true` is used, StyleX wraps output in its own layers (default names, e.g. `stylex.priority1`); the unplugin only forwards a boolean, *not* the `{before, after, prefix}` object (https://stylexjs.com/docs/api/configuration/babel-plugin#uselayers ; https://raw.githubusercontent.com/meta/stylex/main/packages/%40stylexjs/unplugin/src/core.js line 66). Keep it false here to avoid layer-order guesswork.
- `aliases`: required because this repo resolves `@/` (local `vite.config.ts` lines 24–27); StyleX's `aliases` option is documented at https://stylexjs.com/docs/api/configuration/babel-plugin#aliases.
- `unstable_moduleResolution`: "required if you plan to use StyleX's theming APIs" i.e. `defineVars`/`createTheme` (https://stylexjs.com/docs/api/configuration/babel-plugin#unstable_moduleresolution).
- `devPersistToDisk`: persists collected rules to `node_modules/.stylex/rules.json` "so multiple Vite environments can share CSS" — relevant to this repo's RSC/SSR/client split (https://raw.githubusercontent.com/meta/stylex/main/packages/@stylexjs/unplugin/README.md).
- `cssInjectionTarget`: unplugin appends aggregated CSS to `index.css`, `style.css`, or the first `.css` asset by default; this repo's asset is `styles.css` (local `src/app/_frontend.tsx` line 5), so target it explicitly or rename it (https://raw.githubusercontent.com/meta/stylex/main/packages/@stylexjs/unplugin/README.md).

### 2.3 CSS entrypoint and dev HMR

- In production, the plugin appends its aggregated CSS to an existing CSS asset; no `@stylex;` directive is needed with the unplugin path (that directive is for the PostCSS/CLI path). Source: https://stylexjs.com/docs/learn/installation/vite/vite-react ; https://stylexjs.com/docs/learn/installation.
- In dev, add a stylesheet link to `/virtual:stylex.css` and a tiny client shim that imports `virtual:stylex:runtime` (official `DevStyleXInject` pattern). Source: https://stylexjs.com/docs/learn/installation/vite/vite-rsc ; https://raw.githubusercontent.com/meta/stylex/main/packages/@stylexjs/unplugin/README.md.
- Keep `@layer ui-sdk;` at the top of `src/app/_frontend/styles.css` per UI SDK guidance (https://ui-sdk.dev/docs/react/styling-and-animation#the-ui-sdk-layer ; local skill `.agents/skills/ui-sdk/SKILL.md` line 44 — note this skill file is in the user's dirty main tree, not in HEAD).

### 2.4 UI SDK usage in the spec

```
import { Toggle } from '@ui-sdk/react/toggle'
```

- Import from per-component entries; there is no root `@ui-sdk/react` export. Source: https://ui-sdk.dev/docs/react/llms.txt ; local skill line 39.
- Add `@ui-sdk/core/web.css` only if the default look is wanted; it is optional. Source: https://ui-sdk.dev/docs/react/llms.txt ("For a default look to start from, import @ui-sdk/core/web.css once").

---

## 3. Server vs client components

- **StyleX is compile-time.** It produces a static CSS file at build time with "no runtime style injection" and a tiny runtime that merges class names (https://stylexjs.com/docs/learn/). `stylex.props()` returns `{ className: string, style: {...} }` and is spread onto the rendered element (https://stylexjs.com/docs/api/javascript/props). Therefore the same `stylex.create`/`stylex.props` code works in a Server Component (class names land in server HTML) and in a Client Component; there is no client-only provider.
- In RSC builds, `@stylexjs/unplugin` "compiles StyleX for each environment (RSC, SSR, client)" and "every build output receives a single CSS asset with aggregated StyleX styles" (https://stylexjs.com/docs/learn/installation/vite/vite-rsc). The React Router RSC example likewise runs the plugin before the RSC plugin so both bundles share CSS (https://stylexjs.com/docs/learn/installation/vite/react-router).
- Keep style definitions static and module-scoped: `stylex.create` values must be statically analyzable; compile-time constants/variables must come from `defineConsts`/`defineVars`, not arbitrary imported JS values (https://stylexjs.com/docs/llm-resources, "Style authoring guide" → "Don't import non-StyleX values"). Do not try to construct a style object in a server function and pass it across the boundary — pass the already-compiled `stylex.props()` result instead (it is a plain serializable `{className, style}` object per the `props` API above).
- **UI SDK parts already include `"use client"`**; a Server Component may render `<Toggle …/>` directly. Initial HTML (ARIA, tab stops) is server-rendered, hydration attaches handlers. A Server Component wrapper that only renders markup may stay server-side if it uses `renderElement`; custom parts using `usePrimitive`/`usePart`/`createParts` must live in a `'use client'` module. Source: https://ui-sdk.dev/docs/react/server-rendering ; corroborated by `@ui-sdk/react`'s publish script `build-package.mjs --use-client --server primitive.ts --server render-element.ts` (https://registry.npmjs.org/@ui-sdk/react/latest).

---

## 4. Does UI SDK's built-in styling conflict with StyleX?

**No inherent conflict.** Sources:

- UI SDK's own description: "`@ui-sdk/react` … No styles, no dependencies, no providers, no portals"; "They handle interactions, focus, and ARIA attributes. **You choose their markup and styles**" (https://ui-sdk.dev/docs/react/llms.txt ; https://ui-sdk.dev/docs/react/llms.txt → Installation). Local skill line 8 says the same: components "render no styles of their own", with `@ui-sdk/core/web.css` providing an optional default look (`.agents/skills/ui-sdk/SKILL.md`, dirty main tree).
- Styling hooks are `data-slot`, state attributes (`data-pressed`, `data-open`, …), CSS variables, and `className` (which may be a function of state). UI SDK docs explicitly say parts render without styles and show plain CSS, CSS Modules, and Tailwind (https://ui-sdk.dev/docs/react/styling-and-animation). `className`, `style`, and refs passed to parts combine (https://ui-sdk.dev/docs/react/parts-and-composition).
- UI SDK injects a small behavioral stylesheet at runtime into a cascade layer named `ui-sdk` (https://ui-sdk.dev/docs/react/styling-and-animation#the-ui-sdk-layer). This is unrelated to StyleX's atomic classes; declaring `@layer ui-sdk;` in the global stylesheet and keeping StyleX unlayered avoids any precedence surprise (see §2.2).
- **Practical wiring with StyleX:** spread `stylex.props(...)` on native elements; on UI SDK parts pass the returned `className` (StyleX's `props()` also returns a `style` object for dynamic values — UI SDK merges `style` too). Example:

  ```tsx
  const styles = stylex.create({
    toggle: { border: '1px solid gray', borderRadius: 8, padding: 8 },
    pressed: { backgroundColor: 'navy', color: 'white' },
  })

  <Toggle
    {...stylex.props(styles.toggle)}
    className={(state) => state.pressed ? stylex.props(styles.pressed).className : undefined}
  />
  ```

  Keep `stylex.props()` as the only source of `className`/`style` on any given element, and consult each component page for its documented state attributes and CSS variables rather than using generated IDs (https://stylexjs.com/docs/llm-resources "Common antipatterns"; https://ui-sdk.dev/docs/react/styling-and-animation).
- **Optional but recommended:** skip `@ui-sdk/core/web.css` for `/sr12` and style everything with StyleX. This reduces competing sources of font-family/token declarations and keeps the E2E font assertion simple.

---

## 5. Per-brand SR12 tokens with `stylex.defineVars()` — no admin token leak

`stylex.defineVars()` creates CSS custom properties from a variable group. By default names are **unique and hashed**; only keys starting with `--` become literal custom property names. Variables must be **named exports in a `.stylex.ts`/`.stylex.js` file with no other exports**, and are consumed in `create()` calls anywhere in the codebase (https://stylexjs.com/docs/api/javascript/defineVars ; https://stylexjs.com/docs/llm-resources "Defining variables"). Per-brand overrides are `stylex.createTheme(vars, overrides)`, applied by spreading its result into `stylex.props()` on a container so all descendants inherit the theme (https://stylexjs.com/docs/api/javascript/createTheme).

Proposed file (new, frontend-only): `src/app/_frontend/sr12/tokens.stylex.ts`

```ts
import * as stylex from '@stylexjs/stylex'

// Hashed by StyleX; nothing here is named like a Payload admin token.
export const sr12Colors = stylex.defineVars({
  ink: '#1b1b1b',
  surface: '#ffffff',
  accent: '#0f766e',
  cta: '#25d366',
})

export const sr12Type = stylex.defineVars({
  body: 'system-ui, sans-serif',
  // if an explicit CSS var is ever needed, namespace it: '--sr12-body'
})
```

Brand root (server or client component — both work, see §3):

```tsx
import * as stylex from '@stylexjs/stylex'
import { sr12Colors } from './tokens.stylex'

const brandTheme = stylex.createTheme(sr12Colors, {
  ink: '#20140f',
  surface: '#fffaf3',
  accent: '#a3421f',
  cta: '#128c7e',
})

export function Sr12BrandRoot({ children }: { children: React.ReactNode }) {
  return <div {...stylex.props(brandTheme)}>{children}</div>
}
```

Why this satisfies the E2E isolation requirement (`tests/e2e/frontend.e2e.spec.ts` lines 14–23 asserts `--font-family-sans` is empty and zero `fonts.googleapis.com` links):

1. `defineVars` hashes names unless a key literally starts with `--`; we never declare `--font-family-sans`, so nothing can set it on `:root` (https://stylexjs.com/docs/api/javascript/defineVars). If an explicit name is required, prefix it `--sr12-*`.
2. `createTheme` scopes overrides to the subtree that receives its class — not the document root — so brand tokens stay inside the `_frontend`/`/sr12` tree (https://stylexjs.com/docs/api/javascript/createTheme).
3. Keep the existing route-scoped stylesheet link in `src/app/_frontend.tsx` lines 5–11 and do not import `@payloadcms/ui` CSS or Google Fonts into the frontend route (local `src/app/_frontend.tsx`, `src/app/_frontend/index.tsx`, `src/app/_frontend/styles.css`; E2E test as cited above).
4. New font choices belong in StyleX `fontFamily` values using system fonts (e.g. `system-ui`), not a `<link>` in `head` (https://stylexjs.com/docs/learn/).
5. If multiple brands are needed, define one variable group + one theme object per brand (themes "can be created anywhere and passed across files/components", https://stylexjs.com/docs/llm-resources "Creating themes"), and select the theme at the `/sr12` root only.

---

## 6. Risks and fallback

**Risks to record in the spec as smoke tests**

1. **Vite 8 / Rolldown + `unplugin@2.3.10`**: verify `bun run dev:vite` HMR (virtual CSS link) and `bun run build` CSS emission; check that `styles.css` actually contains StyleX rules. If the adapter fails, options are: pin a package-manager override to `unplugin@3.7.0` (untested with StyleX — validate), or use `@stylexjs/postcss-plugin` + `@stylexjs/babel-plugin` manually (https://stylexjs.com/docs/learn/installation#postcss).
2. **Dev CSS injection**: TanStack Start's document shell must include the dev `<link rel="stylesheet" href="/virtual:stylex.css" />` and client shim or styles will flash/miss in dev (https://stylexjs.com/docs/learn/installation/vite/vite-rsc).
3. **TS 7 / `.stylex.ts`**: StyleX packages ship their own types and "no additional configuration is needed" (https://stylexjs.com/docs/llm-resources "TypeScript setup"); the `.stylex.ts` naming is a compiler convention, not a tsconfig change.
4. **UI SDK beta**: APIs may change; repo skill says to read the installed package's `docs/llms.txt` (https://ui-sdk.dev/docs ; local skill lines 12–19).

**Fallback if StyleX integration proves incompatible**

Keep **UI SDK** (it is styling-agnostic) and drop StyleX for `/sr12`:

- Put SR12 tokens in namespaced CSS custom properties (`--sr12-*`) in `src/app/_frontend/styles.css` or a CSS Module imported by `src/app/_frontend/sr12.tsx`. CSS Modules are explicitly supported by UI SDK (https://ui-sdk.dev/docs/react/styling-and-animation#css-modules).
- Style parts with `data-slot` / state attributes and `@layer ui-sdk;` as documented (https://ui-sdk.dev/docs/react/styling-and-animation#the-ui-sdk-layer).
- This preserves the E2E isolation guarantee (no admin tokens, no Google Fonts) and needs no new build plugin; it only gives up StyleX's atomic CSS and typed tokens. Revisit StyleX after `unplugin` publishes a Vite 8-tested release.

---

## Sources (primary only)

- StyleX docs: https://stylexjs.com/docs/learn/ , https://stylexjs.com/docs/learn/installation , https://stylexjs.com/docs/learn/installation/vite/vite-react , https://stylexjs.com/docs/learn/installation/vite/vite-rsc , https://stylexjs.com/docs/learn/installation/vite/react-router , https://stylexjs.com/docs/llm-resources , https://stylexjs.com/docs/api/javascript/defineVars , https://stylexjs.com/docs/api/javascript/createTheme , https://stylexjs.com/docs/api/javascript/props , https://stylexjs.com/docs/api/configuration/babel-plugin
- StyleX source: https://raw.githubusercontent.com/meta/stylex/main/packages/@stylexjs/unplugin/README.md , https://raw.githubusercontent.com/meta/stylex/main/packages/@stylexjs/unplugin/src/core.js , https://raw.githubusercontent.com/meta/stylex/main/packages/@stylexjs/unplugin/src/consts.js
- npm registry: https://registry.npmjs.org/@stylexjs/stylex/latest , https://registry.npmjs.org/@stylexjs/babel-plugin/latest , https://registry.npmjs.org/@stylexjs/unplugin/latest , https://registry.npmjs.org/@stylexjs/esbuild-plugin/latest , https://registry.npmjs.org/@ui-sdk/core/latest , https://registry.npmjs.org/@ui-sdk/react/latest , https://registry.npmjs.org/unplugin , https://registry.npmjs.org/unplugin/2.3.10 , https://registry.npmjs.org/unplugin/latest
- UI SDK docs: https://ui-sdk.dev/docs , https://ui-sdk.dev/llms.txt , https://ui-sdk.dev/docs/react/llms.txt , https://ui-sdk.dev/docs/react/server-rendering , https://ui-sdk.dev/docs/react/styling-and-animation
- Vite: https://vite.dev/blog/announcing-vite8 , https://vite.dev/guide/migration
- Local repo files (commit `c27d4d8`): `package.json`, `vite.config.ts`, `src/app/_frontend.tsx`, `src/app/_frontend/index.tsx`, `src/app/_frontend/styles.css`, `tests/e2e/frontend.e2e.spec.ts`; plus `.agents/skills/ui-sdk/SKILL.md` from the working tree (uncommitted user file, read-only)
