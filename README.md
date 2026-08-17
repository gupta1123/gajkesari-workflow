# Gajkesari

A modern Next.js project built with TypeScript, Tailwind CSS, and Shadcn UI components.

## 🚀 Features

- **Next.js 15** - Latest version with App Router
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Utility-first CSS framework
- **Shadcn UI** - Beautiful, accessible component library
- **ESLint** - Code quality and consistency

## 📦 Installed Components

- Button
- Card
- Input

## 🛠️ Getting Started

### Development Server

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the result.

### Building for Production

```bash
npm run build
npm start
```

## 📚 Adding More Shadcn Components

To add more Shadcn UI components:

```bash
npx shadcn@latest add [component-name]
```

For example:
```bash
npx shadcn@latest add dialog
npx shadcn@latest add dropdown-menu
npx shadcn@latest add form
```

Browse all available components at [ui.shadcn.com](https://ui.shadcn.com)

## 📖 Documentation

- [Next.js Documentation](https://nextjs.org/docs)
- [Shadcn UI Documentation](https://ui.shadcn.com)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [TypeScript Documentation](https://www.typescriptlang.org/docs)

## 📁 Project Structure

```
Gajkesari/
├── src/
│   ├── app/
│   │   ├── layout.tsx      # Root layout
│   │   ├── page.tsx        # Home page
│   │   └── globals.css     # Global styles
│   ├── components/
│   │   └── ui/             # Shadcn UI components
│   └── lib/
│       └── utils.ts        # Utility functions
├── public/                 # Static assets
└── package.json           # Dependencies
```

## 🎨 Customization

### Theme Colors

Edit the CSS variables in `src/app/globals.css` to customize your theme colors.

### Tailwind Configuration

Modify `tailwind.config.ts` for custom Tailwind settings.

### Component Configuration

Check `components.json` for Shadcn UI configuration.

## 📝 License

This project is open source and available under the MIT License.
