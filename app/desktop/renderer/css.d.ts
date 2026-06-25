// esbuild bundelt geïmporteerde CSS naar een los bestand; deze declaratie
// zorgt dat TypeScript de `import './styles.css'` accepteert.
declare module '*.css';
