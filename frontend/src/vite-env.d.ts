/// <reference types="vite/client" />

/*
 * Vite ambient types.
 *
 * Required for `*.module.css` imports: Vite's client types declare the CSS-module
 * shape (`const classes: { readonly [key: string]: string }`). Without this
 * reference, `tsc -b` reports TS2307 for every CSS-module import.
 */
