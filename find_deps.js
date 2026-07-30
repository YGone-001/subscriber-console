const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const fileContent = fs.readFileSync('src/app/(dashboard)/users/page.tsx', 'utf-8');

const ast = parser.parse(fileContent, {
  sourceType: 'module',
  plugins: ['jsx', 'typescript']
});

let toolbarNodePath = null;
let advancedRowNodePath = null;
let bulkBarNodePath = null;

traverse(ast, {
  JSXElement(path) {
    const className = getClassName(path.node);
    if (className === 'users-toolbar' && !toolbarNodePath) toolbarNodePath = path;
    if (className === 'users-advanced-row' && !advancedRowNodePath) advancedRowNodePath = path;
    if (className === 'users-bulk-bar' && !bulkBarNodePath) bulkBarNodePath = path;
  }
});

function getClassName(node) {
  if (node.openingElement.attributes) {
    for (const attr of node.openingElement.attributes) {
      if (attr.name && attr.name.name === 'className' && attr.value && attr.value.type === 'StringLiteral') {
        return attr.value.value;
      }
    }
  }
  return null;
}

function findDependencies(paths) {
  const deps = new Set();
  paths.forEach(p => {
    if (p) {
      p.traverse({
        Identifier(path) {
          if (path.isReferencedIdentifier()) {
            const binding = path.scope.getBinding(path.node.name);
            // If there's a binding and it belongs to a scope outside of p, or no binding
            if (!binding || !isDescendantScope(binding.scope, p.scope)) {
              deps.add(path.node.name);
            }
          }
        }
      });
    }
  });
  return Array.from(deps);
}

function isDescendantScope(scope, parentScope) {
  let s = scope;
  while (s) {
    if (s === parentScope) return true;
    s = s.parent;
  }
  return false;
}

const toolbarDeps = findDependencies([toolbarNodePath, advancedRowNodePath, bulkBarNodePath]);
console.log('Toolbar deps:', toolbarDeps.filter(d => !['t', 'VALID_ROLES', 'VALID_STATUS', 'console'].includes(d)));
