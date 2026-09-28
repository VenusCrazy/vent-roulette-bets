/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        abyss: {
          950: '#060a12',
          900: '#0a0f1a',
          850: '#0d1420',
          800: '#111a2c',
          700: '#182442',
        },
        gold: {
          DEFAULT: '#f59e0b',
          light: '#fbbf24',
          dark: '#d97706',
        },
        flame: {
          DEFAULT: '#dc2626',
          dark: '#b91c1c',
        },
        ocean: {
          DEFAULT: '#3b82f6',
          light: '#60a5fa',
          dark: '#2563eb',
        },
        siren: {
          DEFAULT: '#ec4899',
          light: '#f472b6',
          dark: '#db2777',
        },
      },
      fontFamily: {
        // display = big text role (logo, headings, stat numbers, CTA labels),
        // sans = body copy. Same family today, kept separate so the two
        // roles can diverge later without touching component classNames.
        display: ['"Poppins"', 'system-ui', 'sans-serif'],
        sans: ['"Poppins"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'gold-glow': '0 0 28px rgba(245, 158, 11, 0.28)',
        'ocean-glow': '0 0 28px rgba(59, 130, 246, 0.25)',
        'siren-glow': '0 0 28px rgba(236, 72, 153, 0.25)',
      },
    },
  },
  plugins: [],
}