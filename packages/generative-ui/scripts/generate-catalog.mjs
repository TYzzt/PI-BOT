import { defaultGenerativeUILibrary } from '@assistant-ui/generative-ui/react';
import { z } from 'zod';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const catalog = Object.fromEntries(Object.entries(defaultGenerativeUILibrary).map(([name, entry]) => [name, {
  description: entry.description,
  schema: z.toJSONSchema(entry.properties, { target: 'draft-7' }),
}]));
if (Object.keys(catalog).length !== 35) throw new Error('Review the upstream vocabulary before updating the catalog');
const source = '// Generated from @assistant-ui/generative-ui 0.0.12. Run npm run generate -w @pi-bot/generative-ui.\nexport const widgetCatalog = ' + JSON.stringify(catalog, null, 2) + ' as const;\n';
const target = new URL('../src/catalog.generated.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if ((await readFile(target,'utf8')).replaceAll('\r\n','\n') !== source) throw new Error('Regenerate the assistant-ui catalog');
} else {
  await mkdir(new URL('../src/', import.meta.url), { recursive: true });
  await writeFile(target, source);
}
