// esbuild laadt `.md`-imports als tekst (loader 'text' in build.mjs,
// renderer-target); deze declaratie zorgt dat TypeScript ze accepteert.
declare module '*.md' {
  const text: string;
  export default text;
}
