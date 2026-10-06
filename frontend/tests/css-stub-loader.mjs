/*
 * Node ESM loader that stubs stylesheet imports for unit tests.
 *
 * The application loads `*.css` and `*.module.css` through Vite, which the Node
 * test runner cannot do. Rendering a component that imports a stylesheet
 * therefore fails with ERR_UNKNOWN_FILE_EXTENSION. This hook answers every
 * stylesheet import with an empty module whose default export is a proxy that
 * echoes the requested class name, which is exactly what a CSS module yields for
 * a class that exists.
 *
 * Registered by `tests/register-css-stub.mjs`.
 */
const STUB_SOURCE = `
const styles = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? key : undefined) });
export default styles;
`;

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: STUB_SOURCE };
  }
  return nextLoad(url, context);
}
