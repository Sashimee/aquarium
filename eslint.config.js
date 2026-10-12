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
      'tools/asset-pipeline/src/{anemone,emit,environment,fins,fish,geometry,loft,lod,math,parts,raster,source,voxel}.ts',
      'tools/asset-pipeline/src/geometry.test.ts',
    ],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
