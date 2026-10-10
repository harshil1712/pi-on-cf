# anti-slop provenance

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT) at commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`, copied from the `install-anti-slop` skill's
`skills/install-anti-slop/assets/anti-slop/`, which is identical to upstream `src/` without tests.
These files are ours now: change them to fit the project, and record the change here.

## What is installed

- `index.ts` and `rules/`, `shared/`, `vendor/`: the generic plugin, registered as `anti-slop`
  in `.oxlintrc.json` with every rule it keeps at `error`, plus the native
  `oxc/no-accumulating-spread`.
- `vendor/eslint-stylistic/`: the padding engine behind `require-readable-spacing`, with its
  own MIT `LICENSE` and `UPSTREAM.md`.
- Not upstream's RuleTester suites: the rules are a tool this project uses, not code it ships,
  and `npm run lint` over the codebase is their check here. `tsc` still typechecks `tools/`.

Dependencies: `oxlint` and `@oxlint/plugins` pinned together at the same exact version.

## Local changes

- Removed upstream's opt-in Effect plugin (`effect/`): the project does not use Effect.
- Removed `no-conditional-empty-object-spread`. `...(x ? { x } : {})` is how this codebase
  leaves optional fields out of RPC and JSON payloads; building those objects up statement by
  statement made them longer and mutable without making them safer.
- `no-shape-in-symbol-names` ignores JSX attribute names, such as Kumo's
  `<Button shape="square">`. A prop name belongs to the component that declares it and cannot
  be renamed locally, like the `schema.shape` member reads upstream already allows. When
  merging an upstream update, keep it: `<Button shape="square" />` must pass, while
  `<ShapeTile />` and `const shapeIcon = …` are still reported.

## Configuration choices (`.oxlintrc.json`)

- `no-runtime-typeof` runs with `allowInTypeGuards: true`. Untrusted payloads in the Worker are
  checked with TypeBox, which pi-ai and pi-durable already ship there; the guards in
  `src/lib/json.ts` cover the rest, including the browser, which does not bundle TypeBox.
- `require-safety-comment-for-type-assertion` is off under `test/**`, where fixtures and
  Testing Library queries assert by construction and a wrong assertion fails the test
  itself. Every other rule, `no-chained-type-assertions` included, applies to tests.
