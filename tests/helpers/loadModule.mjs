import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';

export function loadModule(path, dependencies, globals = {}) {
  const testModule = { exports: {} };
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(compiled, { module: testModule, exports: testModule.exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
    return dependencies[name];
  }, URL, Date, crypto, setTimeout, console, ...globals }, { filename: path });
  return testModule.exports;
}
