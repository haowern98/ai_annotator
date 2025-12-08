/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'brand-primary': '#1e40af',
        'brand-secondary': '#3b82f6',
        'base-100': '#0f172a',
        'base-200': '#1e293b',
        'base-300': '#334155',
        'content-100': '#f8fafc',
        'content-200': '#cbd5e1',
      },
    },
  },
  plugins: [],
}
