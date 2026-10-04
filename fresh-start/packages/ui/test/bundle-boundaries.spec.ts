import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Frontend boundaries that a reviewer cannot see in a diff but every user pays for
 * (F-FE). Each guard parses source with the TypeScript compiler rather than grepping, so
 * formatting cannot hide a violation.
 */

const REPO = join(__dirname, '..', '..', '..');
const WEB_SOURCES = [
  join(REPO, 'apps', 'portal-web'),
  join(REPO, 'apps', 'operations-web'),
  join(REPO, 'packages', 'ui', 'src'),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test') return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function relative(file: string): string {
  return file.replace(`${REPO}/`, '');
}

describe('F-FE.3 contract values reach the browser without zod', () => {
  it('web code imports contract values only from @jobwork/contracts/constants', () => {
    const offenders: string[] = [];
    for (const file of WEB_SOURCES.flatMap(walk)) {
      for (const statement of parse(file).statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const from = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (from !== '@jobwork/contracts') continue;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const bindings = clause.namedBindings;
        const values =
          bindings && ts.isNamedImports(bindings)
            ? bindings.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text)
            : ['* (namespace or default import)'];
        if (clause.name) values.push(clause.name.text);
        if (values.length > 0) offenders.push(`${relative(file)}: ${values.join(', ')}`);
      }
    }
    // The package root is CommonJS and re-exports every schema: one value import from it
    // puts zod and all contracts on every route that shares the importing chunk.
    expect(offenders).toEqual([]);
  });

  it('the constants entry never reaches zod, directly or through a relative import', () => {
    const entry = resolve(REPO, 'packages', 'contracts', 'src', 'constants.ts');
    const seen = new Set<string>();
    const reachesZod: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const statement of parse(file).statements) {
        const specifier =
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier
            ? (statement.moduleSpecifier as ts.StringLiteral).text
            : null;
        if (specifier === null) continue;
        if (specifier.startsWith('.')) visit(resolve(dirname(file), `${specifier}.ts`));
        else reachesZod.push(`${relative(file)} imports ${specifier}`);
      }
    };
    visit(entry);
    expect(reachesZod).toEqual([]);
  });
});

describe('F-FE.4 links are links, buttons are buttons', () => {
  it('no app nests a Button inside a Link (use ButtonLink)', () => {
    const offenders: string[] = [];
    const apps = WEB_SOURCES.slice(0, 2).flatMap(walk).filter((file) => file.endsWith('.tsx'));
    for (const file of apps) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node, insideLink: boolean): void => {
        const tag = ts.isJsxElement(node)
          ? node.openingElement.tagName.getText()
          : ts.isJsxSelfClosingElement(node)
            ? node.tagName.getText()
            : null;
        if (insideLink && (tag === 'Button' || tag === 'CommandButton' || tag === 'button')) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          offenders.push(`${relative(file)}:${line + 1}`);
        }
        ts.forEachChild(node, (child) => visit(child, insideLink || tag === 'Link' || tag === 'a'));
      };
      visit(source, false);
    }
    // A button inside a link is invalid interactive nesting: two tab stops, an ambiguous
    // role, and a disabled button that the link still follows.
    expect(offenders).toEqual([]);
  });
});
