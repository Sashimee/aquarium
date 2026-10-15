import type { HtmlTagDescriptor, Plugin, Rolldown } from 'vite';

type OutputBundle = Rolldown.OutputBundle;
type OutputChunk = Rolldown.OutputChunk;

const TANK_MODULE = /[\\/]src[\\/]tank\.ts$/;

function staticClosure(bundle: OutputBundle, root: OutputChunk): Set<string> {
  const seen = new Set<string>();
  const visit = (fileName: string): void => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    const chunk = bundle[fileName];
    if (chunk?.type === 'chunk') for (const dep of chunk.imports) visit(dep);
  };
  visit(root.fileName);
  return seen;
}

/**
 * main.ts imports the three-heavy `src/tank.ts` lazily to keep it out of the initial JS budget,
 * which counts the entry and its modulepreloads. Without a hint its fetch waits for the entry to
 * run. A low-priority `rel=preload` starts it with the HTML instead, yields bandwidth to the
 * entry, and is reused by the later import because the destination and CORS mode match.
 */
export function tankPreloadPlugin(): Plugin {
  let base = '/';
  return {
    name: 'aquarium:tank-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle, chunk: entry }) {
        if (!bundle || !entry) return [];
        const tank = Object.values(bundle).find(
          (output): output is OutputChunk =>
            output.type === 'chunk' &&
            output.isDynamicEntry &&
            TANK_MODULE.test(output.facadeModuleId ?? ''),
        );
        if (!tank) {
          throw new Error('tank-preload: no lazy chunk for src/tank.ts; is it still imported?');
        }
        const initial = staticClosure(bundle, entry);
        return [...staticClosure(bundle, tank)]
          .filter((fileName) => !initial.has(fileName))
          .map((fileName): HtmlTagDescriptor => ({
            tag: 'link',
            attrs: {
              rel: 'preload',
              as: 'script',
              crossorigin: true,
              fetchpriority: 'low',
              href: `${base}${fileName}`,
            },
            injectTo: 'head',
          }));
      },
    },
  };
}
