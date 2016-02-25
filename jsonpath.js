/*global define, module, require*/
/* eslint-disable no-eval */
/* JSONPath 0.8.0 - XPath for JSON
 *
 * Copyright (c) 2007 Stefan Goessner (goessner.net)
 * Licensed under the MIT (MIT-LICENSE.txt) licence.
 */

(function (require) {
  "use strict";

  // Make sure to know if we are in real node or not (the `require` variable
  // could actually be require.js, for example.
  var isNode = typeof module != "undefined" && !!module.exports;

  var allowedResultTypes = ["value", "path", "pointer", "parent", "parentProperty", "all"];

  var vm = isNode ? require("vm") : {
    runInNewContext: function(expr, context) {
      return eval(Object.keys(context).reduce(function(s, vr) {
        return "var " + vr + "=" + JSON.stringify(context[vr]).replace(/\u2028|\u2029/g, function (m) {
          // http://www.thespanner.co.uk/2011/07/25/the-json-specification-is-now-wrong/
          return "\\u202" + (m == "\u2028" ? "8" : "9");
        }) + ";" + s;
      }, expr));
    }
  };

  function cloneAndPush(arr, elem) {
    arr = arr.slice();
    arr.push(elem);
    return arr;
  }

  function cloneAndUnshift(elem, arr) {
    arr = arr.slice();
    arr.unshift(elem);
    return arr;
  }

  function NewError(value) {
    this.avoidNew = true;
    this.value = value;
    this.message = "JSONPath should not be called with 'new' (it prevents return of (unwrapped) scalar values)";
  }

  function JSONPath(opts, expr, obj, callback, otherTypeCallback) {
    if (!(this instanceof JSONPath)) {
      try {
        return new JSONPath(opts, expr, obj, callback, otherTypeCallback);
      } catch (e) {
        if (!e.avoidNew) {
          throw e;
        }
        return e.value;
      }
    }

    if (typeof opts == "string") {
      otherTypeCallback = callback;
      callback = obj;
      obj = expr;
      expr = opts;
      opts = {};
    }
    opts = opts || {};
    let objArgs = opts.hasOwnProperty("json") && opts.hasOwnProperty("path");
    this.json = opts.json || obj;
    this.path = opts.path || expr;
    this.resultType = (opts.resultType && opts.resultType.toLowerCase()) || "value";
    this.flatten = opts.flatten || false;
    this.wrap = opts.hasOwnProperty("wrap") ? opts.wrap : true;
    this.sandbox = opts.sandbox || {};
    this.preventEval = opts.preventEval || false;
    this.parent = opts.parent || null;
    this.parentProperty = opts.parentProperty || null;
    this.callback = opts.callback || callback || null;
    this.otherTypeCallback = opts.otherTypeCallback || otherTypeCallback || function () {
      throw new Error("You must supply an otherTypeCallback callback option with the @other() operator.");
    };

    if (opts.autostart !== false) {
      let ret = this.evaluate({
        path: (objArgs ? opts.path : expr),
        json: (objArgs ? opts.json : obj)
      });
      if (!ret || typeof ret !== "object") {
        throw new NewError(ret);
      }
      return ret;
    }
  }

  // PUBLIC METHODS

  JSONPath.prototype.evaluate = function(expr, json, callback, otherTypeCallback) {
    let flatten = this.flatten;
    let wrap = this.wrap;
    let currParent = this.parent;
    let currParentProperty = this.parentProperty;

    this.currResultType = this.resultType;
    this.currPreventEval = this.preventEval;
    this.currSandbox = this.sandbox;
    callback = callback || this.callback;
    this.currOtherTypeCallback = otherTypeCallback || this.otherTypeCallback;

    json = json || this.json;
    expr = expr || this.path;
    if (expr && typeof expr == "object") {
      if (!expr.path) {
        throw new Error("You must supply a 'path' property when providing an " +
          "object argument to JSONPath.evaluate().");
      }
      json = ("json" in expr) ? expr.json : json;
      flatten = ("flatten" in expr) ? expr.flatten : flatten;
      this.currResultType = ("resultType" in expr) ? expr.resultType : this.currResultType;
      this.currSandbox = ("sandbox" in expr) ? expr.sandbox : this.currSandbox;
      wrap = ("wrap" in expr) ? expr.wrap : wrap;
      this.currPreventEval = ("preventEval" in expr) ? expr.preventEval : this.currPreventEval;
      callback = ("callback" in expr) ? expr.callback : callback;
      this.currOtherTypeCallback = ("otherTypeCallback" in expr) ? expr.otherTypeCallback :
        this.currOtherTypeCallback;
      currParent = ("parent" in expr) ? expr.parent : currParent;
      currParentProperty = ("parentProperty" in expr) ? expr.parentProperty : currParentProperty;
      expr = expr.path;
    }
    currParent = currParent || null;
    currParentProperty = currParentProperty || null;

    if (Array.isArray(expr)) {
      expr = JSONPath.toPathString(expr);
    }
    if (!expr || !json || allowedResultTypes.indexOf(this.currResultType) == -1) {
      return;
    }
    this._obj = json;

    let exprList = JSONPath.toPathArray(expr);
    if (exprList[0] == "$" && exprList.length > 1) {
      exprList.shift();
    }
    let result = this._trace(exprList, json, ["$"], currParent, currParentProperty, callback);
    result = result.filter(ea => ea && !ea.isParentSelector);

    if (!result.length) {
      return wrap ? [] : undefined;
    }
    if (result.length == 1 && !wrap && !Array.isArray(result[0].value)) {
      return this._getPreferredOutput(result[0]);
    }

    return result.reduce((result, ea) => {
      let valOrPath = this._getPreferredOutput(ea);
      if (this.flatten && Array.isArray(valOrPath)) {
        result = result.concat(valOrPath);
      } else {
        result.push(valOrPath);
      }
      return result;
    }, []);
  };

  // PRIVATE METHODS

  JSONPath.prototype._getPreferredOutput = function(ea) {
    let resultType = this.currResultType;
    switch (resultType) {
      case "all":
        ea.path = typeof ea.path == "string" ? ea.path : JSONPath.toPathString(ea.path);
        return ea;
      case "value":
      case "parent":
      case "parentProperty":
        return ea[resultType];
      case "path":
        return JSONPath.toPathString(ea[resultType]);
      case "pointer":
        return JSONPath.toPointer(ea.path);
    }
  };

  JSONPath.prototype._handleCallback = function(fullRetObj, callback, type) {
    if (!callback) {
      return;
    }
    let preferredOutput = this._getPreferredOutput(fullRetObj);
    fullRetObj.path = typeof fullRetObj.path == "string" ? fullRetObj.path :
      JSONPath.toPathString(fullRetObj.path);
    callback(preferredOutput, type, fullRetObj);
  };

  JSONPath.prototype._trace = function(expr, val, path, parent, parentPropName, callback) {
    // No expr to follow? return path and value as the result of this trace branch
    let retObj;
    if (!expr.length) {
      retObj = {
        path: path,
        value: val,
        parent: parent,
        parentProperty: parentPropName
      };
      this._handleCallback(retObj, callback, "value");
      return retObj;
    }

    let loc = expr[0];
    let x = expr.slice(1);

    // We need to gather the return value of recursive trace calls in order to
    // do the parent sel computation.
    let ret = [];
    function addRet(elems) {
      ret = ret.concat(elems);
    }

    // simple case--directly follow property
    if (val && Object.prototype.hasOwnProperty.call(val, loc)) {
      addRet(this._trace(x, val[loc], cloneAndPush(path, loc), val, loc, callback));
    // all child properties
    } else if (loc == "*") {
      this._walk(loc, x, val, path, parent, parentPropName, callback, (m, l, x, v, p, par, pr, cb) => {
        addRet(this._trace(cloneAndUnshift(m, x), v, p, par, pr, cb));
      });
    // all descendent parent properties
    } else if (loc == "..") {
      // Check remaining expression with val's immediate children
      addRet(this._trace(x, val, path, parent, parentPropName, callback));
      this._walk(loc, x, val, path, parent, parentPropName, callback, (m, l, x, v, p, par, pr, cb) => {
        // We don't join m and x here because we only want parents, not scalar values
        // Keep going with recursive descent on val's object children
        if (typeof v[m] == "object") {
          addRet(this._trace(cloneAndUnshift(l, x), v[m], cloneAndPush(p, m), v, m, cb));
        }
      });
    // [(expr)] (dynamic property/index)
    } else if (loc[0] == "(") {
      if (this.currPreventEval) {
        throw new Error("Eval [(expr)] prevented in JSONPath expression.");
      }
      // As this will resolve to a property name (but we don't know it yet),
      // property and parent information is relative to the parent of the
      // property to which this expression will resolve
      addRet(this._trace(cloneAndUnshift(this._eval(loc, val, path[path.length - 1],
        path.slice(0, -1), parent, parentPropName), x), val, path, parent,
        parentPropName, callback));
    // The parent sel computation is handled in the frame above using the
    // ancestor object of val
    } else if (loc == "^") {
      // This is not a final endpoint, so we do not invoke the callback here
      return path.length ? {
        path: path.slice(0, -1),
        expr: x,
        isParentSelector: true
      } : [];
    // property name
    } else if (loc == "~") {
      retObj = {
        path: cloneAndPush(path, loc),
        value: parentPropName,
        parent: parent,
        parentProperty: null
      };
      this._handleCallback(retObj, callback, "property");
      return retObj;
    // root only
    } else if (loc == "$") {
      addRet(this._trace(x, val, path, null, null, callback));
    // [?(expr)] (filtering)
    } else if (loc.indexOf("?(") === 0) {
      if (this.currPreventEval) {
        throw new Error("Eval [?(expr)] prevented in JSONPath expression.");
      }

      this._walk(loc, x, val, path, parent, parentPropName, callback, (m, l, x, v, p, par, pr, cb) => {
        if (this._eval(l.replace(/^\?\((.*?)\)$/, "$1"), v[m], m, p, par, pr)) {
          addRet(this._trace(cloneAndUnshift(m, x), v, p, par, pr, cb));
        }
      });
    // [name1,name2,...]
    } else if (loc.indexOf(",") > -1) {
      let parts = loc.split(",");
      for (let i = 0, l = parts.length; i < l; i++) {
        addRet(this._trace(cloneAndUnshift(parts[i], x), val, path, parent, parentPropName, callback));
      }
    // value type: @boolean(), etc.
    } else if (loc[0] == "@") {
      let addType = false;
      let valueType = loc.slice(1, -2);
      switch (valueType) {
        case "scalar":
          if (!val || (["object", "function"].indexOf(typeof val) == -1)) {
            addType = true;
          }
          break;
        case "boolean":
        case "string":
        case "undefined":
        case "function":
          if (typeof val == valueType) {
            addType = true;
          }
          break;
        case "number":
          if (typeof val == valueType && isFinite(val)) {
            addType = true;
          }
          break;
        case "nonFinite":
          if (typeof val == "number" && !isFinite(val)) {
            addType = true;
          }
          break;
        case "object":
          if (val && typeof val == valueType) {
            addType = true;
          }
            break;
        case "array":
          if (Array.isArray(val)) {
            addType = true;
          }
            break;
        case "other":
          addType = this.currOtherTypeCallback(val, path, parent, parentPropName);
          break;
        case "integer":
          if (val === +val && isFinite(val) && !(val % 1)) {
            addType = true;
          }
          break;
        case "null":
          if (val === null) {
            addType = true;
          }
          break;
      }
      if (addType) {
        retObj = {
          path: path,
          value: val,
          parent: parent,
          parentProperty: parentPropName
        };
        this._handleCallback(retObj, callback, "value");
        return retObj;
      }
    // [start:end:step]  Python slice syntax
    } else if (/^(-?[0-9]*):(-?[0-9]*):?([0-9]*)$/.test(loc)) {
      addRet(this._slice(loc, x, val, path, parent, parentPropName, callback));
    }

    // We check the resulting values for parent selections. For parent
    // selections we discard the value object and continue the trace with the
    // current val object
    return ret.reduce((all, ea) => {
      return all.concat(ea.isParentSelector ?
        this._trace(ea.expr, val, ea.path, parent, parentPropName, callback) : ea);
    }, []);
  };

  JSONPath.prototype._walk = function(loc, expr, val, path, parent, parentPropName, callback, f) {
    if (Array.isArray(val)) {
      for (let i = 0, n = val.length; i < n; i++) {
        f(i, loc, expr, val, path, parent, parentPropName, callback);
      }
    } else if (typeof val == "object") {
      for (let m in val) {
        if (Object.prototype.hasOwnProperty.call(val, m)) {
          f(m, loc, expr, val, path, parent, parentPropName, callback);
        }
      }
    }
  };

  JSONPath.prototype._slice = function(loc, expr, val, path, parent, parentPropName, callback) {
    if (!Array.isArray(val)) {
      return;
    }

    let len = val.length;
    let parts = loc.split(":");
    let start = (parts[0] && parseInt(parts[0], 10)) || 0;
    let end = (parts[1] && parseInt(parts[1], 10)) || len;
    let step = (parts[2] && parseInt(parts[2], 10)) || 1;
    start = (start < 0) ? Math.max(0, start + len) : Math.min(len, start);
    end = (end < 0) ? Math.max(0, end + len) : Math.min(len, end);

    let ret = [];
    for (let i = start; i < end; i += step) {
      ret = ret.concat(this._trace(cloneAndUnshift(i, expr), val, path, parent, parentPropName, callback));
    }
    return ret;
  };

  JSONPath.prototype._eval = function(code, _v, _vname, path, parent, parentPropName) {
    if (!this._obj || !_v) {
      return false;
    }

    if (code.indexOf("@parentProperty") > -1) {
      this.currSandbox._$_parentProperty = parentPropName;
      code = code.replace(/@parentProperty/g, "_$_parentProperty");
    }
    if (code.indexOf("@parent") > -1) {
      this.currSandbox._$_parent = parent;
      code = code.replace(/@parent/g, "_$_parent");
    }
    if (code.indexOf("@property") > -1) {
      this.currSandbox._$_property = _vname;
      code = code.replace(/@property/g, "_$_property");
    }
    if (code.indexOf("@path") > -1) {
      this.currSandbox._$_path = JSONPath.toPathString(path.concat([_vname]));
      code = code.replace(/@path/g, "_$_path");
    }
    if (code.match(/@([\.\s\)\[])/)) {
      this.currSandbox._$_v = _v;
      code = code.replace(/@([\.\s\)\[])/g, "_$_v$1");
    }
    try {
      return vm.runInNewContext(code, this.currSandbox);
    } catch (e) {
      console.log(e);
      throw new Error("jsonPath: " + e.message + ": " + code);
    }
  };

  // PUBLIC CLASS PROPERTIES AND METHODS

  // Could store the cache object itself
  JSONPath.cache = {};

  JSONPath.toPathString = function(pathArr) {
    let p = "$";
    for (let i = 1, n = pathArr.length; i < n; i++) {
      if (!(/^(~|\^|@.*?\(\))$/).test(pathArr[i])) {
        p += (/^[0-9*]+$/).test(pathArr[i]) ?
          ("[" + pathArr[i] + "]") :
          ("['" + pathArr[i] + "']");
      }
    }
    return p;
  };

  JSONPath.toPointer = function(pointer) {
    let p = "";
    for (let i = 1, n = pointer.length; i < n; i++) {
      if (!(/^(~|\^|@.*?\(\))$/).test(pointer[i])) {
        p += "/" + pointer[i].toString()
          .replace(/\~/g, "~0")
          .replace(/\//g, "~1");
      }
    }
    return p;
  };

  JSONPath.toPathArray = function(expr) {
    let cache = JSONPath.cache;
    if (cache[expr]) {
      return cache[expr];
    }

    let subx = [];
    let normalized = expr
      // Properties
      .replace(/@(?:null|boolean|number|string|integer|undefined|nonFinite|scalar|array|object|function|other)\(\)/g, ";$&;")
      // Parenthetical evaluations (filtering and otherwise), directly within
      // brackets or single quotes
      .replace(/[\['](\??\(.*?\))[\]']/g, ($0, $1) => "[#" + (subx.push($1) - 1) + "]")
      // Escape periods and tildes within properties
      .replace(/\['([^'\]]*)'\]/g, function($0, prop) {
        return "['" + prop.replace(/\./g, "%@%").replace(/~/g, "%%@@%%") + "']";
      })
      // Properties operator
      .replace(/~/g, ";~;")
      // Split by property boundaries
      .replace(/'?\.'?(?![^\[]*\])|\['?/g, ";")
      // Reinsert periods within properties
      .replace(/%@%/g, ".")
      // Reinsert tildes within properties
      .replace(/%%@@%%/g, "~")
      // Parent
      .replace(/(?:;)?(\^+)(?:;)?/g, ($0, ups) => ";" + ups.split("").join(";") + ";")
      // Descendents
      .replace(/;;;|;;/g, ";..;")
      // Remove trailing
      .replace(/;$|'?\]|'$/g, "");

    let exprList = normalized.split(";").map(function (expr) {
      let match = expr.match(/#([0-9]+)/);
      return !match || !match[1] ? expr : subx[match[1]];
    });
    return cache[expr] = exprList;
  };

  if (typeof define == "function" && define.amd) {
    define(function() {
      return JSONPath;
    });
  } else if (isNode) {
    module.exports = JSONPath;
  } else {
    self.JSONPath = JSONPath;
  }
}(typeof require == "undefined" ? null : require));
