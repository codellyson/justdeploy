import justuiPreset from '@codellyson/justui/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [justuiPreset],
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
    // Include justui's compiled React components so their token classes get generated.
    './node_modules/@codellyson/justui/dist/**/*.js',
  ],
};
