// Structural public-contract comparison for `spec/public-api.d.ts` and the
// emitted `dist/index.d.ts` tree.
//
// The frozen spec is the authoritative minimum contract:
//   - the set of exported names must match exactly (a new or removed export
//     requires a deliberate spec change);
//   - every exported declaration in the spec must be satisfied by the package;
//   - additive members and overloads are compatible and reported as advisories;
//   - removals, required-member additions, optional-to-required changes, and
//     any signature/type change are failures.
//
// Declarations are tokenised and parsed into a small structural model instead
// of being compared with regular expressions. Dist re-exports are resolved
// through the emitted declaration tree, so the check always validates the
// package's public contract rather than isolated source files.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenise a declaration file. Comments and all insignificant whitespace are
 * dropped; string and template literals stay atomic.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      tokens.push(source.slice(start, index));
      continue;
    }
    if (char === "`") {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      tokens.push(source.slice(start, index));
      continue;
    }
    if (IDENTIFIER.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\w$]/u.test(source[index])) index += 1;
      tokens.push(source.slice(start, index));
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[0-9.]/u.test(source[index])) index += 1;
      tokens.push(source.slice(start, index));
      continue;
    }
    if (source.startsWith("...", index)) {
      tokens.push("...");
      index += 3;
      continue;
    }
    if (source.startsWith("=>", index)) {
      tokens.push("=>");
      index += 2;
      continue;
    }
    tokens.push(char);
    index += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const OPENERS = new Set(["(", "[", "{", "<"]);
const CLOSERS = new Set([")", "]", "}", ">"]);

function isIdentifier(token) {
  return token !== undefined && IDENTIFIER.test(token);
}

function isStringLiteral(token) {
  return (
    token !== undefined &&
    token.length >= 2 &&
    (token[0] === '"' || token[0] === "'") &&
    token.at(-1) === token[0]
  );
}

function isOpener(token) {
  return OPENERS.has(token);
}

/** Index after the balanced group that starts at `start`. */
function skipBalanced(tokens, start) {
  const open = tokens[start];
  const close = { "(": ")", "[": "]", "{": "}", "<": ">" }[open];
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index] === open) depth += 1;
    else if (tokens[index] === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return tokens.length;
}

/** Split tokens on a separator at the top level of every bracket group. */
function splitTopLevel(tokens, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isOpener(token)) depth += 1;
    else if (CLOSERS.has(token)) depth = Math.max(0, depth - 1);
    else if (token === separator && depth === 0) {
      parts.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts;
}

function findTopLevel(tokens, target, start = 0) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isOpener(token)) depth += 1;
    else if (CLOSERS.has(token)) depth = Math.max(0, depth - 1);
    else if (token === target && depth === 0) return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Type canonicalisation
// ---------------------------------------------------------------------------

/** Reduce an `import("module").Name` sequence to one canonical token. */
function collapseImportTypes(tokens) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index] === "import" &&
      tokens[index + 1] === "(" &&
      isStringLiteral(tokens[index + 2]) &&
      tokens[index + 3] === ")" &&
      tokens[index + 4] === "." &&
      isIdentifier(tokens[index + 5])
    ) {
      out.push(`import(${jsonString(tokens[index + 2])}).${tokens[index + 5]}`);
      index += 5;
      continue;
    }
    out.push(tokens[index]);
  }
  return out;
}

function jsonString(literal) {
  if (literal.startsWith('"')) return literal;
  // A single-quoted literal is normalised to a double-quoted one so the spec
  // and emitted declarations compare equal regardless of quote style.
  return JSON.stringify(literal.slice(1, -1));
}

function unquote(literal) {
  return literal.slice(1, -1);
}

/** Sort top-level union members; their order carries no meaning. */
function normalizeUnionOrder(tokens) {
  const parts = splitTopLevel(tokens, "|").filter((part) => part.length > 0);
  if (parts.length <= 1) return (parts[0] ?? []).join(" ");
  return parts
    .map((part) => part.join(" "))
    .sort()
    .join(" | ");
}

/**
 * Canonical text for a type expression: import aliases are resolved, imported
 * type syntax is collapsed, and top-level union order is normalised.
 *
 * @param {string[]} tokens
 * @param {Map<string, {canonical: string}>} aliases
 * @returns {string}
 */
function canonicalType(tokens, aliases) {
  const collapsed = collapseImportTypes(tokens);
  const resolved = collapsed.map((token) =>
    isIdentifier(token) && aliases.has(token)
      ? aliases.get(token).canonical
      : token,
  );
  return normalizeUnionOrder(
    resolved.filter((token) => token !== ";" && token !== ","),
  );
}

function parseTypeParameters(tokens, aliases) {
  if (tokens === undefined || tokens.length === 0) return "";
  const inner = tokens.slice(1, -1);
  const parameters = splitTopLevel(inner, ",")
    .filter((part) => part.length > 0)
    .map((part) => {
      const name = part[0];
      let index = 1;
      let constraint = "";
      let fallback = "";
      if (part[index] === "extends") {
        const equals = findTopLevel(part, "=", index + 1);
        const end = equals === -1 ? part.length : equals;
        constraint = canonicalType(part.slice(index + 1, end), aliases);
        index = end;
      }
      if (part[index] === "=") {
        fallback = canonicalType(part.slice(index + 1), aliases);
      }
      return `${name}${constraint === "" ? "" : ` extends ${constraint}`}${
        fallback === "" ? "" : ` = ${fallback}`
      }`;
    });
  return parameters.join(", ");
}

function parseParameters(tokens, aliases) {
  const inner = tokens.slice(1, -1);
  const parameters = splitTopLevel(inner, ",")
    .filter((part) => part.length > 0)
    .map((part) => {
      let index = 0;
      let rest = false;
      if (part[index] === "...") {
        rest = true;
        index += 1;
      }
      if (isIdentifier(part[index])) index += 1;
      else if (part[index] === "[" || part[index] === "{") {
        index = skipBalanced(part, index);
      }
      let optional = false;
      if (part[index] === "?") {
        optional = true;
        index += 1;
      }
      let type = "";
      if (part[index] === ":") {
        type = canonicalType(part.slice(index + 1), aliases);
      } else if (part[index] === "=") {
        // A parameter initializer is not part of the callable contract.
        type = canonicalType(part.slice(0, index), aliases);
      } else {
        type = canonicalType(part.slice(index), aliases);
      }
      return { rest, optional, type };
    });
  return parameters;
}

function parseSignature(tokens, aliases) {
  let index = 0;
  let typeParameters = "";
  if (tokens[index] === "<") {
    const end = skipBalanced(tokens, index);
    typeParameters = parseTypeParameters(tokens.slice(index, end), aliases);
    index = end;
  }
  if (tokens[index] !== "(") return undefined;
  const paramsEnd = skipBalanced(tokens, index);
  const parameters = parseParameters(tokens.slice(index, paramsEnd), aliases);
  let returnType = "";
  if (tokens[paramsEnd] === ":") {
    returnType = canonicalType(tokens.slice(paramsEnd + 1), aliases);
  }
  return { typeParameters, parameters, returnType };
}

function signatureText(signature) {
  const generics =
    signature.typeParameters === "" ? "" : `<${signature.typeParameters}>`;
  const parameters = signature.parameters
    .map(
      (parameter) =>
        `${parameter.rest ? "..." : ""}${parameter.type}${
          parameter.optional ? "?" : ""
        }`,
    )
    .join(", ");
  return `${generics}(${parameters}) => ${signature.returnType}`;
}

// ---------------------------------------------------------------------------
// Declaration parsing
// ---------------------------------------------------------------------------

const DECLARATION_KEYWORDS = new Set([
  "function",
  "class",
  "interface",
  "type",
  "const",
  "let",
  "var",
  "enum",
]);

const MEMBER_MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "abstract",
  "readonly",
  "override",
  "declare",
  "accessor",
  "get",
  "set",
]);

function parseImport(tokens, index) {
  // `import` [type] {...}/Name/* as ns from "module";
  let cursor = index + 1;
  if (tokens[cursor] === "type") cursor += 1;
  const bindings = [];
  if (tokens[cursor] === "{") {
    const end = skipBalanced(tokens, cursor);
    for (const part of splitTopLevel(tokens.slice(cursor + 1, end - 1), ",")) {
      let offset = 0;
      if (part[offset] === "type") offset += 1;
      const imported = part[offset];
      if (!isIdentifier(imported)) continue;
      const alias = part[offset + 1] === "as" ? part[offset + 2] : imported;
      bindings.push({ imported, alias });
    }
    cursor = end;
  } else if (isIdentifier(tokens[cursor])) {
    bindings.push({ imported: "default", alias: tokens[cursor] });
    cursor += 1;
    if (tokens[cursor] === ",") cursor += 1;
  } else if (tokens[cursor] === "*" && tokens[cursor + 1] === "as") {
    bindings.push({ imported: "*", alias: tokens[cursor + 2] });
    cursor += 3;
  }
  if (tokens[cursor] !== "from" || !isStringLiteral(tokens[cursor + 1])) {
    return { next: cursor + 1, bindings: [] };
  }
  const moduleName = unquote(tokens[cursor + 1]);
  for (const binding of bindings) {
    binding.module = moduleName;
  }
  return { next: cursor + 2, bindings };
}

function parseExportBlock(tokens, index) {
  // `export` [type] { ... } [from "module"] ;
  let cursor = index + 1;
  let typeOnly = false;
  if (tokens[cursor] === "type") {
    typeOnly = true;
    cursor += 1;
  }
  if (tokens[cursor] !== "{") return undefined;
  const end = skipBalanced(tokens, cursor);
  const names = [];
  for (const part of splitTopLevel(tokens.slice(cursor + 1, end - 1), ",")) {
    let offset = 0;
    if (part[offset] === "type") offset += 1;
    const original = part[offset];
    if (!isIdentifier(original)) continue;
    const alias = part[offset + 1] === "as" ? part[offset + 2] : original;
    names.push({ original, alias });
  }
  cursor = end;
  let from;
  if (tokens[cursor] === "from" && isStringLiteral(tokens[cursor + 1])) {
    from = unquote(tokens[cursor + 1]);
    cursor += 2;
  }
  if (tokens[cursor] === ";") cursor += 1;
  return { next: cursor, names, from, typeOnly };
}

function parseMembers(bodyTokens, aliases) {
  const members = new Map();
  for (const raw of splitTopLevel(bodyTokens, ";")) {
    const tokens = raw.filter((token) => token !== ",");
    if (tokens.length === 0) continue;
    let index = 0;
    let visibility = "public";
    let readonly = false;
    let optional = false;
    let isStatic = false;
    while (index < tokens.length && MEMBER_MODIFIERS.has(tokens[index])) {
      const modifier = tokens[index];
      if (
        (modifier === "get" || modifier === "set") &&
        tokens[index + 1] === "("
      ) {
        // `get()`/`set()` is a method name, not an accessor modifier.
        break;
      }
      if (modifier === "private" || modifier === "protected") {
        visibility = modifier;
      } else if (modifier === "readonly") {
        readonly = true;
      } else if (modifier === "static") {
        isStatic = true;
      }
      index += 1;
    }
    if (visibility !== "public") continue;
    if (index >= tokens.length) continue;

    // Construct signature: `new (...) : T`
    if (tokens[index] === "new") {
      const signature = parseSignature(tokens.slice(index + 1), aliases);
      if (signature !== undefined) {
        addMethod(members, "new", signature);
      }
      continue;
    }
    // Call signature: `(...) : T`
    if (tokens[index] === "(") {
      const signature = parseSignature(tokens.slice(index), aliases);
      if (signature !== undefined) addMethod(members, "call", signature);
      continue;
    }
    // Constructors are not part of the instance-side structural contract that
    // consumers observe and the frozen spec intentionally leaves them out.
    if (tokens[index] === "constructor") {
      continue;
    }
    // Index signature: `[key: string]: T`
    if (tokens[index] === "[") {
      const end = skipBalanced(tokens, index);
      let type = "";
      if (tokens[end] === ":") {
        type = canonicalType(tokens.slice(end + 1), aliases);
      }
      members.set("[index]", {
        kind: "index",
        readonly,
        optional: false,
        type,
        isStatic,
      });
      continue;
    }

    let name;
    let nameToken = tokens[index];
    if (isIdentifier(nameToken) || isStringLiteral(nameToken)) {
      name = nameToken;
      index += 1;
    } else {
      continue;
    }
    if (tokens[index] === "?") {
      optional = true;
      index += 1;
    }
    if (tokens[index] === "<" || tokens[index] === "(") {
      const signature = parseSignature(tokens.slice(index), aliases);
      if (signature === undefined) continue;
      if (optional) {
        // An optional method is still callable; record it as a method.
      }
      addMethod(members, name, signature, { readonly, isStatic });
      continue;
    }
    let type = "";
    if (tokens[index] === ":") {
      type = canonicalType(tokens.slice(index + 1), aliases);
    } else if (tokens[index] === "=") {
      // A literal class field, e.g. `readonly code = "ERR_X"`.
      type = canonicalType(tokens.slice(index + 1), aliases);
    }
    members.set(name, {
      kind: "property",
      readonly,
      optional,
      type,
      isStatic,
    });
  }
  return members;
}

function addMethod(members, name, signature, extra = {}) {
  const existing = members.get(name);
  const signatures =
    existing !== undefined && existing.kind === "method"
      ? [...existing.signatures, signature]
      : [signature];
  members.set(name, {
    kind: "method",
    signatures,
    readonly: extra.readonly === true,
    isStatic: extra.isStatic === true,
  });
}

function parseDeclaration(tokens, index, aliases) {
  // tokens[index] is the declaration keyword.
  let cursor = index + 1;
  const keyword = tokens[index];
  if (keyword === "function") {
    const name = tokens[cursor];
    if (!isIdentifier(name)) return undefined;
    cursor += 1;
    const semicolon = findTopLevel(tokens, ";", cursor);
    const end = semicolon === -1 ? tokens.length : semicolon;
    const signature = parseSignature(tokens.slice(cursor, end), aliases);
    return {
      next: semicolon === -1 ? tokens.length : semicolon + 1,
      declaration: {
        name,
        kind: "function",
        signatures: signature === undefined ? [] : [signature],
      },
    };
  }
  if (keyword === "class" || keyword === "interface") {
    let name = tokens[cursor];
    if (name === "abstract") {
      cursor += 1;
      name = tokens[cursor];
    }
    if (!isIdentifier(name)) return undefined;
    cursor += 1;
    let typeParameters = "";
    if (tokens[cursor] === "<") {
      const end = skipBalanced(tokens, cursor);
      typeParameters = parseTypeParameters(tokens.slice(cursor, end), aliases);
      cursor = end;
    }
    const bodyStart = tokens.indexOf("{", cursor);
    if (bodyStart === -1) return undefined;
    const heritageTokens = tokens.slice(cursor, bodyStart);
    const bodyEnd = skipBalanced(tokens, bodyStart);
    const members = parseMembers(
      tokens.slice(bodyStart + 1, bodyEnd - 1),
      aliases,
    );
    let next = bodyEnd;
    if (tokens[next] === ";") next += 1;
    return {
      next,
      declaration: {
        name,
        kind: keyword === "class" ? "class" : "interface",
        typeParameters,
        heritage: canonicalType(heritageTokens, aliases),
        members,
      },
    };
  }
  if (keyword === "type") {
    const name = tokens[cursor];
    if (!isIdentifier(name)) return undefined;
    cursor += 1;
    let typeParameters = "";
    if (tokens[cursor] === "<") {
      const end = skipBalanced(tokens, cursor);
      typeParameters = parseTypeParameters(tokens.slice(cursor, end), aliases);
      cursor = end;
    }
    if (tokens[cursor] !== "=") return undefined;
    const semicolon = findTopLevel(tokens, ";", cursor + 1);
    const end = semicolon === -1 ? tokens.length : semicolon;
    const typeTokens = tokens.slice(cursor + 1, end);
    return {
      next: semicolon === -1 ? tokens.length : semicolon + 1,
      declaration: {
        name,
        kind: "type",
        typeParameters,
        typeTokens,
        type: canonicalType(typeTokens, aliases),
      },
    };
  }
  if (keyword === "const" || keyword === "let" || keyword === "var") {
    const name = tokens[cursor];
    if (!isIdentifier(name)) return undefined;
    cursor += 1;
    let typeTokens = [];
    if (tokens[cursor] === ":") {
      const semicolon = findTopLevel(tokens, ";", cursor + 1);
      const end = semicolon === -1 ? tokens.length : semicolon;
      typeTokens = tokens.slice(cursor + 1, end);
    }
    const semicolon = findTopLevel(tokens, ";", cursor);
    return {
      next: semicolon === -1 ? tokens.length : semicolon + 1,
      declaration: {
        name,
        kind: "const",
        type: canonicalType(typeTokens, aliases),
        typeTokens,
      },
    };
  }
  return undefined;
}

/**
 * Parse one declaration module into local declarations and export entries.
 *
 * @param {string} source
 * @returns {{
 *   source: string,
 *   declarations: Map<string, object>,
 *   exports: Array<object>,
 *   imports: Map<string, {module: string, name: string}>,
 * }}
 */
export function parseModule(source) {
  const tokens = tokenize(source);
  const declarations = new Map();
  const exports = [];
  const imports = new Map();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "import") {
      const parsed = parseImport(tokens, index);
      for (const binding of parsed.bindings) {
        if (binding.module !== undefined) {
          imports.set(binding.alias, {
            module: binding.module,
            name: binding.imported,
            canonical: binding.module.startsWith(".")
              ? binding.imported
              : `import(${jsonString(`"${binding.module}"`)}).${binding.imported}`,
          });
        }
      }
      index = parsed.next;
      continue;
    }
    if (token !== "export") {
      // Parse local declarations for local re-export resolution.
      let cursor = index;
      if (tokens[cursor] === "declare") cursor += 1;
      if (DECLARATION_KEYWORDS.has(tokens[cursor])) {
        const parsed = parseDeclaration(tokens, cursor, imports);
        if (parsed !== undefined) {
          addDeclaration(declarations, parsed.declaration);
          index = parsed.next;
          continue;
        }
      }
      index += 1;
      continue;
    }

    const block = parseExportBlock(tokens, index);
    if (block !== undefined) {
      exports.push({ kind: "block", ...block });
      index = block.next;
      continue;
    }

    let cursor = index + 1;
    if (tokens[cursor] === "declare") cursor += 1;
    if (tokens[cursor] === "*") {
      // `export * from "module";`
      if (
        tokens[cursor + 1] === "from" &&
        isStringLiteral(tokens[cursor + 2])
      ) {
        exports.push({
          kind: "star",
          from: unquote(tokens[cursor + 2]),
        });
        index = cursor + 3;
        if (tokens[index] === ";") index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (tokens[cursor] === "default") {
      index += 1;
      continue;
    }
    if (DECLARATION_KEYWORDS.has(tokens[cursor])) {
      const parsed = parseDeclaration(tokens, cursor, imports);
      if (parsed !== undefined) {
        addDeclaration(declarations, parsed.declaration);
        exports.push({
          kind: "declaration",
          name: parsed.declaration.name,
          declaration: parsed.declaration,
        });
        index = parsed.next;
        continue;
      }
    }
    index += 1;
  }
  return { source, declarations, exports, imports };
}

function addDeclaration(declarations, declaration) {
  const existing = declarations.get(declaration.name);
  if (existing !== undefined && declaration.kind === "function") {
    declarations.set(declaration.name, {
      ...existing,
      signatures: [...existing.signatures, ...declaration.signatures],
    });
    return;
  }
  declarations.set(declaration.name, declaration);
}

/** Add an export, merging function overloads that share a name. */
function addExport(exportMap, name, declaration) {
  const existing = exportMap.get(name);
  if (
    existing !== undefined &&
    existing.kind === "function" &&
    declaration.kind === "function"
  ) {
    exportMap.set(name, {
      ...existing,
      signatures: [...existing.signatures, ...declaration.signatures],
    });
    return;
  }
  exportMap.set(name, declaration);
}

// ---------------------------------------------------------------------------
// Declaration-tree linking
// ---------------------------------------------------------------------------

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(fromFile), specifier);
  if (target.endsWith(".d.ts")) return target;
  if (target.endsWith(".js")) return `${target.slice(0, -3)}.d.ts`;
  if (target.endsWith(".mjs")) return `${target.slice(0, -4)}.d.ts`;
  return `${target}.d.ts`;
}

function createLoader() {
  /** @type {Map<string, Promise<object>>} */
  const modules = new Map();
  /** @type {Map<string, Promise<Map<string, object>>>} */
  const exportMaps = new Map();

  async function loadModule(file) {
    const absolute = resolve(file);
    let pending = modules.get(absolute);
    if (pending === undefined) {
      pending = readFile(absolute, "utf8").then((source) =>
        parseModule(source),
      );
      modules.set(absolute, pending);
    }
    return await pending;
  }

  async function resolveAlias(moduleFile, declaration, seen) {
    if (declaration.kind !== "type") return declaration;
    if (declaration.typeTokens.length !== 1) return declaration;
    const name = declaration.typeTokens[0];
    if (!isIdentifier(name)) return declaration;
    const key = `${moduleFile}#${name}`;
    if (seen.has(key)) return declaration;
    seen.add(key);
    const module = await loadModule(moduleFile);
    const imported = module.imports.get(name);
    if (imported !== undefined) {
      const targetFile = resolveSpecifier(moduleFile, imported.module);
      if (targetFile !== undefined) {
        const targetMap = await exportsOf(targetFile);
        const target = targetMap.get(imported.name);
        if (target !== undefined)
          return await resolveAlias(targetFile, target, seen);
      }
      return declaration;
    }
    const local = module.declarations.get(name);
    if (local !== undefined) return await resolveAlias(moduleFile, local, seen);
    return declaration;
  }

  async function exportsOf(file) {
    const absolute = resolve(file);
    let pending = exportMaps.get(absolute);
    if (pending !== undefined) return await pending;
    pending = (async () => {
      const module = await loadModule(absolute);
      const result = new Map();
      for (const entry of module.exports) {
        if (entry.kind === "declaration") {
          addExport(
            result,
            entry.name,
            await resolveAlias(absolute, entry.declaration, new Set()),
          );
          continue;
        }
        if (entry.kind === "star") {
          const targetFile = resolveSpecifier(absolute, entry.from);
          if (targetFile === undefined) continue;
          const target = await exportsOf(targetFile);
          for (const [name, declaration] of target) {
            if (name !== "default") addExport(result, name, declaration);
          }
          continue;
        }
        if (entry.kind === "block") {
          if (entry.from === undefined) {
            for (const { original, alias } of entry.names) {
              const local = module.declarations.get(original);
              if (local !== undefined) {
                addExport(
                  result,
                  alias,
                  await resolveAlias(absolute, local, new Set()),
                );
                continue;
              }
              const imported = module.imports.get(original);
              if (imported === undefined) continue;
              const targetFile = resolveSpecifier(absolute, imported.module);
              if (targetFile === undefined) continue;
              const target = await exportsOf(targetFile);
              const declaration = target.get(imported.name);
              if (declaration !== undefined) {
                addExport(
                  result,
                  alias,
                  await resolveAlias(targetFile, declaration, new Set()),
                );
              }
            }
            continue;
          }
          const targetFile = resolveSpecifier(absolute, entry.from);
          if (targetFile === undefined) continue;
          const target = await exportsOf(targetFile);
          for (const { original, alias } of entry.names) {
            const declaration = target.get(original);
            if (declaration !== undefined) {
              addExport(
                result,
                alias,
                await resolveAlias(targetFile, declaration, new Set()),
              );
            }
          }
        }
      }
      return result;
    })();
    exportMaps.set(absolute, pending);
    return await pending;
  }

  return { loadModule, exportsOf };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function sameSignature(left, right) {
  return signatureText(left) === signatureText(right);
}

function describeSignature(signature) {
  return signatureText(signature);
}

function sign(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function compareSignatures(specSignatures, distSignatures, symbol, violations) {
  for (const [index, specSignature] of specSignatures.entries()) {
    const matched = distSignatures.some((candidate) =>
      sameSignature(specSignature, candidate),
    );
    if (matched) continue;
    const closest = distSignatures[index] ?? distSignatures[0];
    let detail = "overload removed or changed";
    if (closest !== undefined) {
      if (specSignature.returnType !== closest.returnType) {
        detail = `return type changed (spec: ${sign(specSignature.returnType)}, dist: ${sign(closest.returnType)})`;
      } else if (specSignature.typeParameters !== closest.typeParameters) {
        detail = `generic constraint/default changed (spec: <${specSignature.typeParameters}>, dist: <${closest.typeParameters}>)`;
      } else if (
        specSignature.parameters.length !== closest.parameters.length
      ) {
        detail = `parameter count changed (spec: ${specSignature.parameters.length}, dist: ${closest.parameters.length})`;
      } else {
        const parameterIndex = specSignature.parameters.findIndex(
          (parameter, position) =>
            parameter.type !== closest.parameters[position].type ||
            parameter.optional !== closest.parameters[position].optional ||
            parameter.rest !== closest.parameters[position].rest,
        );
        if (parameterIndex !== -1) {
          const specParameter = specSignature.parameters[parameterIndex];
          const distParameter = closest.parameters[parameterIndex];
          detail = `parameter ${parameterIndex + 1} type/optionality changed (spec: ${sign(
            `${specParameter.rest ? "..." : ""}${specParameter.type}${specParameter.optional ? "?" : ""}`,
          )}, dist: ${sign(
            `${distParameter.rest ? "..." : ""}${distParameter.type}${distParameter.optional ? "?" : ""}`,
          )})`;
        } else {
          detail = "declaration signature changed";
        }
      }
      detail += ` in overload ${index + 1}; spec: ${describeSignature(
        specSignature,
      )}; dist: ${describeSignature(closest)}`;
    }
    violations.push({
      severity: "breaking",
      symbol,
      message: detail,
    });
  }
}

function compareMembers(
  specDeclaration,
  distDeclaration,
  symbol,
  violations,
  advisories,
) {
  const specMembers = specDeclaration.members;
  const distMembers = distDeclaration.members;
  for (const [name, specMember] of specMembers) {
    const distMember = distMembers.get(name);
    const memberSymbol = `${symbol}.${name}`;
    if (distMember === undefined) {
      violations.push({
        severity: "breaking",
        symbol: memberSymbol,
        message: `member removed (expected ${specMember.kind})`,
      });
      continue;
    }
    if (specMember.kind !== distMember.kind) {
      violations.push({
        severity: "breaking",
        symbol: memberSymbol,
        message: `member kind changed from ${specMember.kind} to ${distMember.kind}`,
      });
      continue;
    }
    if (specMember.kind === "method") {
      compareSignatures(
        specMember.signatures,
        distMember.signatures,
        memberSymbol,
        violations,
      );
      if (distMember.signatures.length > specMember.signatures.length) {
        advisories.push({
          severity: "compatible",
          symbol: memberSymbol,
          message: `${distMember.signatures.length - specMember.signatures.length} additional overload(s) not present in the spec (compatible addition)`,
        });
      }
      continue;
    }
    if (specMember.kind === "index") {
      if (specMember.type !== distMember.type) {
        violations.push({
          severity: "breaking",
          symbol: memberSymbol,
          message: `index signature type changed (spec: ${sign(specMember.type)}, dist: ${sign(distMember.type)})`,
        });
      }
      continue;
    }
    if (specMember.type !== distMember.type) {
      violations.push({
        severity: "breaking",
        symbol: memberSymbol,
        message: `property type changed (spec: ${sign(specMember.type)}, dist: ${sign(distMember.type)})`,
      });
      continue;
    }
    if (specMember.optional && !distMember.optional) {
      violations.push({
        severity: "breaking",
        symbol: memberSymbol,
        message: "optional property became required",
      });
    } else if (!specMember.optional && distMember.optional) {
      advisories.push({
        severity: "compatible",
        symbol: memberSymbol,
        message: "required property became optional (compatible relaxation)",
      });
    }
    if (specMember.readonly && !distMember.readonly) {
      advisories.push({
        severity: "compatible",
        symbol: memberSymbol,
        message: "readonly modifier removed (compatible relaxation)",
      });
    } else if (!specMember.readonly && distMember.readonly) {
      violations.push({
        severity: "breaking",
        symbol: memberSymbol,
        message: "readonly modifier added to a writable property",
      });
    }
  }
  for (const [name] of distMembers) {
    if (!specMembers.has(name)) {
      advisories.push({
        severity: "compatible",
        symbol: `${symbol}.${name}`,
        message:
          "additional member not present in the spec (compatible addition)",
      });
    }
  }
}

function compareDeclaration(
  specDeclaration,
  distDeclaration,
  symbol,
  violations,
  advisories,
) {
  if (specDeclaration.kind !== distDeclaration.kind) {
    violations.push({
      severity: "breaking",
      symbol,
      message: `declaration kind changed from ${specDeclaration.kind} to ${distDeclaration.kind}`,
    });
    return;
  }
  if (specDeclaration.kind === "function") {
    compareSignatures(
      specDeclaration.signatures,
      distDeclaration.signatures,
      symbol,
      violations,
    );
    if (distDeclaration.signatures.length > specDeclaration.signatures.length) {
      advisories.push({
        severity: "compatible",
        symbol,
        message: `${distDeclaration.signatures.length - specDeclaration.signatures.length} additional overload(s) not present in the spec (compatible addition)`,
      });
    }
    return;
  }
  if (
    specDeclaration.kind === "class" ||
    specDeclaration.kind === "interface"
  ) {
    if (specDeclaration.typeParameters !== distDeclaration.typeParameters) {
      violations.push({
        severity: "breaking",
        symbol,
        message: `generic type parameters changed (spec: <${specDeclaration.typeParameters}>, dist: <${distDeclaration.typeParameters}>)`,
      });
    }
    if (specDeclaration.heritage !== distDeclaration.heritage) {
      violations.push({
        severity: "breaking",
        symbol,
        message: `heritage clause changed (spec: ${sign(specDeclaration.heritage)}, dist: ${sign(distDeclaration.heritage)})`,
      });
    }
    compareMembers(
      specDeclaration,
      distDeclaration,
      symbol,
      violations,
      advisories,
    );
    return;
  }
  if (specDeclaration.kind === "type" || specDeclaration.kind === "const") {
    if (specDeclaration.typeParameters !== distDeclaration.typeParameters) {
      violations.push({
        severity: "breaking",
        symbol,
        message: `generic type parameters changed (spec: <${specDeclaration.typeParameters}>, dist: <${distDeclaration.typeParameters}>)`,
      });
    }
    if (specDeclaration.type !== distDeclaration.type) {
      violations.push({
        severity: "breaking",
        symbol,
        message: `type expression changed (spec: ${sign(specDeclaration.type)}, dist: ${sign(distDeclaration.type)})`,
      });
    }
  }
}

/**
 * Compare a spec declaration file against the emitted package entry point.
 *
 * @param {{ specPath: string, distPath: string }} paths
 * @returns {Promise<{ ok: boolean, specExports: number, distExports: number,
 *   violations: object[], advisories: object[] }>}
 */
export async function checkContract({ specPath, distPath }) {
  const loader = createLoader();
  const specModule = await loader.loadModule(specPath);
  const specExports = new Map();
  for (const entry of specModule.exports) {
    if (entry.kind === "declaration") {
      addExport(specExports, entry.name, entry.declaration);
    } else if (entry.kind === "block" && entry.from === undefined) {
      for (const { original, alias } of entry.names) {
        const declaration = specModule.declarations.get(original);
        if (declaration !== undefined)
          addExport(specExports, alias, declaration);
      }
    }
  }
  const distExports = await loader.exportsOf(distPath);

  const violations = [];
  const advisories = [];

  for (const name of distExports.keys()) {
    if (!specExports.has(name)) {
      violations.push({
        severity: "breaking",
        symbol: name,
        message:
          "exported by the package but absent from spec/public-api.d.ts (the spec must change first)",
      });
    }
  }
  for (const [name, specDeclaration] of specExports) {
    const distDeclaration = distExports.get(name);
    if (distDeclaration === undefined) {
      violations.push({
        severity: "breaking",
        symbol: name,
        message:
          "declared in spec/public-api.d.ts but not exported by the package",
      });
      continue;
    }
    compareDeclaration(
      specDeclaration,
      distDeclaration,
      name,
      violations,
      advisories,
    );
  }

  return {
    ok: violations.length === 0,
    specExports: specExports.size,
    distExports: distExports.size,
    violations,
    advisories,
  };
}

/**
 * Format a check result for a terminal, one finding per line.
 *
 * @param {Awaited<ReturnType<typeof checkContract>>} result
 * @param {{ verbose?: boolean }} [options]
 * @returns {string}
 */
export function formatResult(result, options = {}) {
  const lines = [];
  if (result.violations.length > 0) {
    lines.push(
      "freeze:check FAILED — public contract diverged from the frozen spec:",
    );
    for (const violation of result.violations) {
      lines.push(
        `- [breaking] ${violation.symbol}: ${truncate(violation.message)}`,
      );
    }
  } else {
    lines.push(
      `freeze:check OK — ${result.specExports} public exports match the frozen contract structurally.`,
    );
  }
  if (result.advisories.length > 0) {
    if (options.verbose === true) {
      lines.push(
        `Note: ${result.advisories.length} compatible difference(s) not represented in the spec:`,
      );
      for (const advisory of result.advisories) {
        lines.push(
          `- [compatible] ${advisory.symbol}: ${truncate(advisory.message)}`,
        );
      }
    } else {
      lines.push(
        `Note: ${result.advisories.length} compatible difference(s) not represented in the spec (run with --verbose to list them).`,
      );
    }
  }
  return lines.join("\n");
}

function truncate(text, limit = 600) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
