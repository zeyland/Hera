// Compile a rules json to typescript

import type { HeraAST, StructuralHandling } from "./machine.js";

interface CompileOptions {
  types: boolean;
};

const strDefs: string[] = [];
const reDefs: string[] = [];

/**
Define a literal string terminal
*/
const defineTerminal = function(lit: string) {
  const index = strDefs.indexOf(lit);
  let id;

  if (index >= 0) {
    id = `$L${index}`;
  }
  else {
    id = `$L${strDefs.length}`;
    strDefs.push(lit);
  };

  return id;
};

/**
Define a RegExp terminal
*/
const defineRe = function(re: string) {
  const index = reDefs.indexOf(re);
  let id;

  if (index >= 0) {
    id = `$R${index}`;
  }
  else {
    id = `$R${reDefs.length}`;
    reDefs.push(re);
  };

  return id;
};

/**
Pretty print a string or RegExp literal
*/
const prettyPrint = function(name: string, terminal: string, re?: boolean) {
  let pv;
  if (re) {
    pv = `/${terminal}/`;
  }
  else {
    pv = JSON.stringify(terminal);
  };

  return `${name} ${pv}`;
};

/**
Compile an operator to a JS or TS string.
*/
const compileOp = function(tuple: HeraAST, name: string, defaultHandler: boolean, types: boolean): string {
  // TODO: should nested levels have default handler set to true? (only comes into play on regexps)
  if (Array.isArray(tuple)) {
    switch (tuple[0]) {
      case "L":
        {
          const args = tuple[1];
          return `$EXPECT(${defineTerminal(args)}, fail, ${JSON.stringify(prettyPrint(name, args))})`;
        };
      case "R":
        {
          const args = tuple[1];
          let f = `$EXPECT(${defineRe(args)}, fail, ${JSON.stringify(prettyPrint(name, args, true))})`;
          if (defaultHandler) {
            f =`$R$0(${f})${reType(types, args)}`;
          };

          return f;
        };
      case "/":
        {
          const src = tuple[1].map(function(arg) {
            compileOp(arg, name, defaultHandler, types);
          })
          .join(", ");

          return `$C(${src})`;
        };
      case "S":
        {
          const src = tuple[1].map(function(arg) {
            compileOp(arg, name, defaultHandler, types);
          })
          .join(", ");
          return `$S(${src})`;
        };
      case "*":
        return `$Q(${compileOp(tuple[1], name, defaultHandler, types)})`;
      case "+":
        return `$P(${compileOp(tuple[1], name, defaultHandler, types)})`;
      case "?":
        return `$E(${compileOp(tuple[1], name, defaultHandler, types)})`;
      case "$":
        // Inside text can ignore all handlers since they are disregarded anyway
        return `$TEXT(${compileOp(tuple[1], name, false, types)})`;
      case "&":
        return `$Y(${compileOp(tuple[1], name, defaultHandler, types)})`;
      case "!":
        return `$N(${compileOp(tuple[1], name, defaultHandler, types)})`;
      default:
        if (tuple[0].name) {
          return compileOp(tuple[1], name, defaultHandler, types);
        }
        else {
          throw new Error(`Unknown op: ${tuple[0]} ${JSON.stringify(tuple[1])}`);
        };
};
  }
  else { // rule reference
    return tuple;
  };
};

// Only rules have handlers, either one per choice line,
// or one for the whole deal

const regExpHandlerParams = ["$skip", "$loc", "$0", "$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9"];
const regularHandlerParams = ["$skip", "$loc", "$0", "$1"];

// Offset is so sequences start at the first item in the array
// and regexps start at the second because the first is the entire match
// TODO: is 0 valid to select the entire sequence result?
// TODO: remove offset and unify handlings
const compileStructuralHandler = function(mapping: StructuralHandling, source: any, single=false, offset=-1): string {
  switch (typeof mapping) {
    case "string":
      return JSON.stringify(mapping);
    case "object":
      if (Array.isArray(mapping)) {
        return `[${mapping.map(function(m) { compileStructuralHandler(m, source, single, offset) }).join(', ')}]`;
      }
      else if (mapping === null) {
        return "null";
      }
      else if ("l" in mapping) {
        return String(mapping.l);
      }
      else if ("v" in mapping) {
        if (single) {
          return source;
        }
        else {
          if (typeof mapping.v === 'number') {
            const n = mapping.v+offset;
            if (n === -1) { // Handle $0
              return source;
            }
            else { // Handle $1, $2, etc.
              return `${source}[${n}]`;
            };
          }
          else {
            return mapping.v;
          };
        };
      }
      else if ("o" in mapping) {
        const o = mapping.o;
        return "{" + Object.keys(o).map(function(key) {
          `${JSON.stringify(key)}: ${compileStructuralHandler(o[key], source, single, offset)}`;
        })
        .join(", ") + "}";
      }
      else {
        throw new Error("unknown object mapping");
      };
    default: // number, boolean, undefined
      return String(mapping);
};
};

const compileHandler = function(options: CompileOptions, arg: HeraAST, name: string) {
  if (typeof arg === "string") {
    return arg;
  }; // reference to other named parser function

  if (arg.length === 3) {
    const h = arg[2];
    if (h && typeof h === "object" && "f" in h) { // function mapping
      const parser = compileOp(arg, name, false, options.types);

      if (arg[0] === "S") {
        // Gather names from each element in arg[1]
        // Only handle top level names for now
        // TODO: transform based on structure, walk AST tree to gather named parameters and mappings based on structural location
        const namedParameters = arg[1].map(function(node, i) {
          getParameterDeclaration(node, i+1);
        })
        .join("");

        const parameters = ["$skip", "$loc", "$0"].concat(arg[1].map((_, i) => `$${i+1}`));

        return `$TS(${parser}, function(${parameters.join(", ")}) {${namedParameters}${h.f}})`;
      }

      else if (arg[0] === "R") {
        // NOTE: RegExp named groups may go here later
        return `$TR(${parser}, function(${regExpHandlerParams.join(", ")}) {${h.f}})`;
      }
      else {
        const namedParameters = getParameterDeclaration(arg, 0);

        return `$TV(${parser}, function(${regularHandlerParams.join(", ")}) {${namedParameters}${h.f}})`;
      };
    }

    else { // structural mapping
      const parser = compileOp(arg, name, false, options.types);
      if (arg[0] === "S") {
        const namedParameters = arg[1].map(function(node, i) {
          const varName = getNamedVariable(node[0]);
          if (varName) {
            `var ${varName} = value[${i}];`;
          }
          else {
            "";
          };
        })
        .join("");
        return `$T(${parser}, function(value) {${namedParameters}return ${compileStructuralHandler(h, "value")} })`;
      }
      else if (arg[0] === "R") {
        return `$T(${parser}, function(value) { return ${compileStructuralHandler(h, "value", false, 0)} })`;
      }
      else {
        // This is 'single' so if there is a named variable it comes out as 'value'
        return `$T(${parser}, function(value) { return ${compileStructuralHandler(h, "value", true)} })`;
      };
    };
  };

  return compileOp(arg, name, true, options.types);
};

const compileRule = function(options: CompileOptions, name: string, rule: HeraAST) {
  const stateType = options.types ? ": ParseState" : "";

  // first level choice may have nested handlings
  if (typeof rule === "string" || !(rule[0] === "/" && !rule[2])) {
    return `
      const ${name}$0 = ${compileHandler(options, rule, name)};
      function ${name}(state${stateType}) {
        if (state.verbose) console.log("ENTER:", ${JSON.stringify(name)});
        if (state.tokenize) {
          return $TOKEN(${JSON.stringify(name)}, state, ${name}$0(state));
        } else {
          return ${name}$0(state);
        }
      }
    `;
  }
  else {
    const args = rule[1];
    const fns = args.map(function(arg, i) {
      `const ${name}$${i} = ${compileHandler(options, arg, name)};`;
    });

    const choices = args.map(function(_, i) {
      `${name}$${i}(state)`;
    })
    .join(" || ");

    return `
      ${fns.join("\n")}
      function ${name}(state${stateType}) {
        if (state.tokenize) {
          return $TOKEN(${JSON.stringify(name)}, state, ${choices});
        } else {
          return ${choices}
        }
      }
    `;
  };
};

const compileRulesObject = function(ruleNames: string[]) {
  const meat = ruleNames.map(function(name) {
    `${name}: ${name}`;
  })
  .join(",\n");


  `{
    ${meat}
  }`;
};

/**
Get a JS declaration string for nodes that have named parameters.
*/
const getParameterDeclaration = function(node: HeraAST, i: number) {
  const name = getNamedVariable(node[0]);

  return name
    ? `var ${name} = $${i};`
    : "";
};

/**
Get a JS declaration string for nodes that have named parameters.
*/
const getNamedVariable = function(op: HeraAST[0]): string | undefined {
  if (typeof op === "object" && "name" in op) {
    return op.name;
  };
  return undefined;
};

const defaultOptions = {
  types: false,
};

module.exports = {
  compile(rules: {[k: string]: HeraAST}, options=defaultOptions) {
    // NOTE: This is only for building the Hera parser. `compile` won't magically work for other language parsers built.
    // TODO: Esbuild doesn't handle this correctly so the machine.* files need to be copied when bundling
    const tsMachine = require('fs').readFileSync(__dirname + "/machine.ts", "utf8");
    const jsMachine = require('fs').readFileSync(__dirname + "/machine.js", "utf8");

    const { types } = options;
    const ruleNames = Object.keys(rules);

    const body = ruleNames.map(function(name) {
      compileRule(options, name, rules[name]);
    })
    .join("\n\n");

    const header = types ? tsMachine : jsMachine;

    `${header}

    const { parse } = parserState(${compileRulesObject(ruleNames)})

    ${ strDefs.map(function(str, i) {
      return `const $L${i} = $L("${str}");`;
    })
    .join("\n") }

    ${ reDefs.map(function(r, i) {
      return `const $R${i} = $R(new RegExp(${JSON.stringify(r)}, 'suy'));`;
    })
    .join("\n") }

    ${body}

    module.exports = {
      parse: parse
    }
    `;
  },
};

const isSimple = /^[^.*+?{}()\[\]^\\]*$/;
const isSimpleCharacterClass = /^\[[^-^\\]*\]$/;

/**
Generate a more specific TypeScript type for Regular expressions that consist of
limited productions. Returns an empty string if `types` is `false`.
*/
const reType = function(types: boolean, str: string) {
  if (types) {
    let specifics;
    if (str.match(isSimple)) {
      specifics = str.split("|").map(function(s) {
        JSON.stringify(s);
      });
    }
    else if (str.match(isSimpleCharacterClass)) {
      specifics = str.substring(1, str.length-1).split("").map(function(s) {
        JSON.stringify(s);
      });
    };

    if (specifics) {
      return ` as Parser<${specifics.join("|")}>`;
    }
    else {
      return "";
    };
  }
  else {
    return "";
  };
};
