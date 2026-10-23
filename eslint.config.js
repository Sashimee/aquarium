import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: [
      'tools/asset-pipeline/src/{anemone,audio-dsp,bristles,tentacles,crew-scan,hermit,nerite,crew-debug,dense-edit,rebake,scan-bake,glossy-eyes,emit,environment,fins,finish,fish,geometry,impostor,loft,lod,math,mouth,parts,raster,rgbe,scan-paint,shrimp,source,voxel,leaf-atlas}.ts',
      'tools/asset-pipeline/src/{audio-dsp,bristles,budgets,crew-lods,scan-bake,crew-scan,emit-lods,hermit,nerite,glossy-eyes,finish,geometry,impostor,mouth,octahedral,raster,rgbe,scan-paint,shrimp,leaf-atlas}.test.ts',
    ],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
