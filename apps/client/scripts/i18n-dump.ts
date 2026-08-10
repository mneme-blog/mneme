// Dumps the English catalog to a flat JSON reference (scripts/i18n.en.json)
// for the translation pass, and prints coverage stats for each locale file
// under src/i18n/locales/. Run: pnpm --filter client exec tsx scripts/i18n-dump.ts
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { en } from '../src/i18n/en';

const here = dirname(fileURLToPath(import.meta.url));
const keys = Object.keys(en) as (keyof typeof en)[];

// Cross-fragment key collisions are silent in en.ts (object spread last-wins);
// the "keys keep their area prefix" rule is convention only. Enforce it here:
// re-import each fragment and check that no key appears in two of them.
{
  const fragmentsDir = join(here, '..', 'src', 'i18n', 'messages');
  const owner = new Map<string, string>();
  let collisions = 0;
  for (const f of readdirSync(fragmentsDir).filter((f) => f.endsWith('.ts'))) {
    const mod = (await import(join(fragmentsDir, f))) as Record<string, Record<string, string>>;
    for (const frag of Object.values(mod)) {
      if (typeof frag !== 'object') continue;
      for (const k of Object.keys(frag)) {
        const prev = owner.get(k);
        if (prev && prev !== f) {
          console.error(`  COLLISION: key '${k}' defined in both ${prev} and ${f}`);
          collisions++;
        }
        owner.set(k, f);
      }
    }
  }
  if (collisions > 0) {
    console.error(`${collisions} cross-fragment key collision(s) — last spread silently wins. Rename the keys.`);
    process.exit(1);
  }
}

const out = join(here, 'i18n.en.json');
writeFileSync(out, JSON.stringify(en, null, 2) + '\n');
console.log(`English catalog: ${keys.length} keys → ${out}`);

const localesDir = join(here, '..', 'src', 'i18n', 'locales');
if (existsSync(localesDir)) {
  const files = readdirSync(localesDir).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const mod = await import(join(localesDir, f));
    const cat = (mod.default ?? {}) as Record<string, string>;
    const have = keys.filter((k) => typeof cat[k] === 'string' && cat[k].length > 0).length;
    const extra = Object.keys(cat).filter((k) => !(k in en));
    console.log(
      `  ${f}: ${have}/${keys.length} translated` +
        (extra.length ? ` — ${extra.length} unknown keys: ${extra.slice(0, 5).join(', ')}` : ''),
    );
  }
} else {
  console.log('  (no locales/ dir yet)');
}
