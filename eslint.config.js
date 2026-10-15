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
      'tools/asset-pipeline/src/{anemone,bristles,tentacles,glossy-eyes,emit,environment,fins,finish,fish,geometry,impostor,loft,lod,math,parts,raster,rgbe,shrimp,source,voxel}.ts',
      'tools/asset-pipeline/src/{bristles,budgets,emit-lods,glossy-eyes,finish,geometry,impostor,octahedral,raster,rgbe,shrimp}.test.ts',
    ],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
