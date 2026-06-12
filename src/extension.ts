import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type * as TypeScript from "typescript";
import * as vscode from "vscode";

type Measurement = {
  cacheHit: boolean;
  fileName: string;
  nodeKind: string;
  typeText: string;
  programMs: number;
  resolveMs: number;
  score: number;
  factors: string[];
};

type ProgramBundle = {
  program: TypeScript.Program;
  checker: TypeScript.TypeChecker;
  sourceFile: TypeScript.SourceFile;
  programMs: number;
  optionsSignature: string;
};

const measurementCache = new Map<string, Measurement>();
let ts: typeof TypeScript;
let decorationType: vscode.TextEditorDecorationType;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  ts = loadTypeScript();
  output = vscode.window.createOutputChannel("TSPerf Type Lens");
  decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 1rem",
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "italic"
    }
  });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  statusBar.command = "tsperf.inspectTypeAtCursor";
  statusBar.text = "TSPerf";
  statusBar.tooltip = "Inspect TypeScript type latency at cursor";

  context.subscriptions.push(
    output,
    decorationType,
    statusBar,
    vscode.commands.registerCommand("tsperf.inspectTypeAtCursor", inspectAtCursor),
    vscode.commands.registerCommand("tsperf.benchmarkCurrentFile", benchmarkCurrentFile),
    vscode.commands.registerCommand("tsperf.clearCache", clearCache)
  );

  if (isTypeScriptEditor(vscode.window.activeTextEditor)) {
    statusBar.show();
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (isTypeScriptEditor(editor)) {
        statusBar.show();
      } else {
        statusBar.hide();
      }
    })
  );
}

export function deactivate(): void {
  measurementCache.clear();
}

function loadTypeScript(): typeof TypeScript {
  const candidates: string[] = [];
  const configuredTsdk = vscode.workspace.getConfiguration("typescript").get<string>("tsdk");
  if (configuredTsdk) {
    const tsdk = path.isAbsolute(configuredTsdk)
      ? configuredTsdk
      : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", configuredTsdk);
    candidates.push(path.join(tsdk, "typescript.js"));
    candidates.push(path.join(tsdk, "lib", "typescript.js"));
  }

  const builtIn = vscode.extensions.getExtension("vscode.typescript-language-features");
  if (builtIn) {
    candidates.push(path.join(builtIn.extensionPath, "node_modules", "typescript", "lib", "typescript.js"));
  }

  candidates.push("typescript");

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(candidate) as typeof TypeScript;
    } catch {
      // Try the next known TypeScript SDK location.
    }
  }

  throw new Error("Unable to load a TypeScript SDK from VS Code, typescript.tsdk, or extension dependencies.");
}

async function inspectAtCursor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!isTypeScriptEditor(editor)) {
    vscode.window.showWarningMessage("Open a TypeScript file before running TSPerf.");
    return;
  }

  try {
    const measurement = measureAtPosition(editor.document, editor.selection.active);
    renderMeasurement(editor, measurement);
    writeMeasurement(measurement);
    vscode.window.showInformationMessage(
      `TSPerf: ${measurement.resolveMs.toFixed(2)}ms, score ${measurement.score}, ${measurement.cacheHit ? "warm cache" : "cold cache"}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`TSPerf failed: ${message}`);
    vscode.window.showErrorMessage(`TSPerf failed: ${message}`);
  }
}

async function benchmarkCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!isTypeScriptEditor(editor)) {
    vscode.window.showWarningMessage("Open a TypeScript file before running TSPerf.");
    return;
  }

  const document = editor.document;
  const identifiers = collectIdentifierPositions(document.getText())
    .slice(0, 80)
    .map((offset) => document.positionAt(offset));

  if (identifiers.length === 0) {
    vscode.window.showWarningMessage("No identifiers found to benchmark.");
    return;
  }

  const measurements = identifiers.map((position) => measureAtPosition(document, position));
  const resolveTimes = measurements.map((item) => item.resolveMs).sort((a, b) => a - b);
  const average = resolveTimes.reduce((sum, item) => sum + item, 0) / resolveTimes.length;
  const p95 = resolveTimes[Math.min(resolveTimes.length - 1, Math.floor(resolveTimes.length * 0.95))];
  const max = resolveTimes[resolveTimes.length - 1];

  output.show(true);
  output.appendLine("");
  output.appendLine(`Benchmark: ${document.fileName}`);
  output.appendLine(`Samples: ${measurements.length}`);
  output.appendLine(`Average resolve: ${average.toFixed(2)}ms`);
  output.appendLine(`P95 resolve: ${p95.toFixed(2)}ms`);
  output.appendLine(`Max resolve: ${max.toFixed(2)}ms`);
  output.appendLine(`Highest score: ${Math.max(...measurements.map((item) => item.score))}`);

  vscode.window.showInformationMessage(
    `TSPerf benchmark: avg ${average.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms, max ${max.toFixed(2)}ms`
  );
}

function clearCache(): void {
  measurementCache.clear();
  vscode.window.showInformationMessage("TSPerf measurement cache cleared.");
}

function measureAtPosition(document: vscode.TextDocument, position: vscode.Position): Measurement {
  const offset = document.offsetAt(position);
  const bundle = buildProgram(document.fileName);
  const cacheKey = [
    document.uri.toString(),
    document.version,
    offset,
    bundle.optionsSignature
  ].join(":");

  const cached = measurementCache.get(cacheKey);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  const node = findSmallestNode(bundle.sourceFile, offset);
  const start = performance.now();
  const type = bundle.checker.getTypeAtLocation(node);
  const resolveMs = performance.now() - start;
  const maxDepth = vscode.workspace.getConfiguration("tsperf").get<number>("maxDepth", 5);
  const scored = scoreType(type, bundle.checker, maxDepth);
  const typeText = bundle.checker.typeToString(
    type,
    node,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias
  );

  const measurement: Measurement = {
    cacheHit: false,
    fileName: document.fileName,
    nodeKind: ts.SyntaxKind[node.kind] ?? String(node.kind),
    typeText,
    programMs: bundle.programMs,
    resolveMs,
    score: scored.score,
    factors: scored.factors
  };

  measurementCache.set(cacheKey, measurement);
  return measurement;
}

function buildProgram(fileName: string): ProgramBundle {
  const programStart = performance.now();
  const configPath = ts.findConfigFile(path.dirname(fileName), ts.sys.fileExists, "tsconfig.json");
  let parsed: TypeScript.ParsedCommandLine;

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    }
    parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  } else {
    parsed = {
      options: {
        allowJs: false,
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2022
      },
      fileNames: [fileName],
      errors: []
    };
  }

  const rootNames = parsed.fileNames.includes(fileName) ? parsed.fileNames : [...parsed.fileNames, fileName];
  const program = ts.createProgram(rootNames, parsed.options);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error(`Could not load source file in TypeScript program: ${fileName}`);
  }

  return {
    program,
    checker: program.getTypeChecker(),
    sourceFile,
    programMs: performance.now() - programStart,
    optionsSignature: signatureForOptions(parsed.options)
  };
}

function findSmallestNode(sourceFile: TypeScript.SourceFile, offset: number): TypeScript.Node {
  let best: TypeScript.Node = sourceFile;

  function visit(node: TypeScript.Node): void {
    const start = node.getStart(sourceFile, false);
    const end = node.getEnd();
    if (offset < start || offset > end) {
      return;
    }
    best = node;
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return best;
}

function scoreType(type: TypeScript.Type, checker: TypeScript.TypeChecker, maxDepth: number): { score: number; factors: string[] } {
  const seen = new Set<TypeScript.Type>();
  const factors: string[] = [];

  function visit(current: TypeScript.Type, depth: number): number {
    if (seen.has(current) || depth > maxDepth) {
      return 0;
    }
    seen.add(current);

    let score = 1;
    const textLength = checker.typeToString(current).length;
    if (textLength > 120) {
      score += Math.min(20, Math.ceil(textLength / 80));
      if (depth === 0) {
        factors.push(`rendered type length ${textLength}`);
      }
    }

    if (current.isUnionOrIntersection()) {
      const childTypes = current.types;
      score += childTypes.length * 3;
      if (depth === 0) {
        factors.push(`${current.isUnion() ? "union" : "intersection"} breadth ${childTypes.length}`);
      }
      score += childTypes.reduce((sum, child) => sum + visit(child, depth + 1), 0);
    }

    const properties = checker.getPropertiesOfType(current);
    if (properties.length > 0) {
      score += Math.min(80, properties.length * 2);
      if (depth === 0) {
        factors.push(`properties ${properties.length}`);
      }
      for (const property of properties.slice(0, 20)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (declaration) {
          score += visit(checker.getTypeOfSymbolAtLocation(property, declaration), depth + 1);
        }
      }
    }

    const callSignatures = checker.getSignaturesOfType(current, ts.SignatureKind.Call);
    const constructSignatures = checker.getSignaturesOfType(current, ts.SignatureKind.Construct);
    if (callSignatures.length + constructSignatures.length > 0) {
      score += (callSignatures.length + constructSignatures.length) * 6;
      if (depth === 0) {
        factors.push(`signatures ${callSignatures.length + constructSignatures.length}`);
      }
    }

    if (isTypeReference(current)) {
      const args = checker.getTypeArguments(current);
      if (args.length > 0) {
        score += args.length * 4;
        if (depth === 0) {
          factors.push(`generic arguments ${args.length}`);
        }
        score += args.reduce((sum, child) => sum + visit(child, depth + 1), 0);
      }
    }

    return score;
  }

  const score = visit(type, 0);
  return {
    score,
    factors: factors.length > 0 ? factors : ["simple type"]
  };
}

function renderMeasurement(editor: vscode.TextEditor, measurement: Measurement): void {
  const activeLine = editor.selection.active.line;
  const line = editor.document.lineAt(activeLine);
  const text = ` TSPerf ${measurement.resolveMs.toFixed(2)}ms | score ${measurement.score}`;
  editor.setDecorations(decorationType, [
    {
      range: new vscode.Range(line.range.end, line.range.end),
      renderOptions: {
        after: {
          contentText: text
        }
      }
    }
  ]);
  statusBar.text = `TSPerf ${measurement.resolveMs.toFixed(1)}ms`;
  statusBar.tooltip = `Score ${measurement.score}; ${measurement.cacheHit ? "warm cache" : "cold cache"}`;
}

function writeMeasurement(measurement: Measurement): void {
  output.show(true);
  output.appendLine("");
  output.appendLine(`File: ${measurement.fileName}`);
  output.appendLine(`Node: ${measurement.nodeKind}`);
  output.appendLine(`Program build: ${measurement.programMs.toFixed(2)}ms`);
  output.appendLine(`Type resolve: ${measurement.resolveMs.toFixed(2)}ms`);
  output.appendLine(`Cache: ${measurement.cacheHit ? "hit" : "miss"}`);
  output.appendLine(`Complexity score: ${measurement.score}`);
  output.appendLine(`Factors: ${measurement.factors.join(", ")}`);
  output.appendLine(`Type: ${measurement.typeText}`);
}

function collectIdentifierPositions(text: string): number[] {
  const sourceFile = ts.createSourceFile("benchmark.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offsets: number[] = [];

  function visit(node: TypeScript.Node): void {
    if (ts.isIdentifier(node)) {
      offsets.push(node.getStart(sourceFile));
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return offsets;
}

function isTypeScriptEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
  return Boolean(
    editor &&
      (editor.document.languageId === "typescript" || editor.document.languageId === "typescriptreact") &&
      editor.document.uri.scheme === "file" &&
      fs.existsSync(editor.document.fileName)
  );
}

function isTypeReference(type: TypeScript.Type): type is TypeScript.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as TypeScript.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
}

function signatureForOptions(options: TypeScript.CompilerOptions): string {
  return JSON.stringify({
    strict: options.strict,
    target: options.target,
    module: options.module,
    jsx: options.jsx,
    baseUrl: options.baseUrl,
    paths: options.paths
  });
}
