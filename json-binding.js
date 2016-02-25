JSON.model = (function() {

  const SYMBOL_PATH = "__path__";

  function modelImpl(json) {
    this.listeners = new Map();
    this.futureListeners = new Map();
    this.load(json || {});
  };

  function getObjectProxy(obj, path, model) {
    let isArray = Array.isArray(obj);
    let keys = isArray ? obj : Object.getOwnPropertyNames(obj);
    let count = 0;
    let val, key;
    for (let i of keys) {
      val = isArray ? i : obj[i];
      key = isArray ? count : i
      if (typeof val == "object") {
        let childPath = path.concat(key);
        obj[key] = getObjectProxy(val, childPath, model);
      }
      ++count;
    }
    obj[SYMBOL_PATH] = path;
    return getGenericProxy(obj, model);
  }

  function getGenericProxy(obj, model) {
    return new Proxy(obj, {
      set: function(target, prop, newVal) {
        if (prop == SYMBOL_PATH) {
          return true;
        }

        if (typeof newVal == "object") {
          newVal = getObjectProxy(newVal, target[SYMBOL_PATH], model);
        }
        let oldVal = target[prop];
        target[prop] = newVal;

        model.notify("set", obj, prop, oldVal, newVal);

        return true;
      },
      defineProperty: function(target, prop, desc) {
        // Let's not allow defineProperty, to avoid unnecessary complexity.
        return false;
      },
      deleteProperty: function(target, prop) {
        let oldVal = target[prop];
        delete target[prop];

        model.notify("delete", target, prop, oldVal);
      },
      setPrototypeOf: function(target, proto) {
        // noop.
      },
      preventExtensions: function(target) {
        // noop.
      }
    })
  }

  modelImpl.prototype = {
    load: function(json = {}) {
      // TODO: Allow extending model with sub-path parameter.
      for (let prop of Object.getOwnPropertyNames(json)) {
        if (typeof json[prop] == "object") {
          json[prop] = getObjectProxy(json[prop], ["$", prop], this);
        }
      }
      json[SYMBOL_PATH] = ["$"];
      this.data = getGenericProxy(json, this);
    },
    selectAll: function(path, from) {
      let result = [];
      JSONPath({
        path: path,
        json: from ? this.select(from) || this.data : this.data,
        resultType: "value",
        callback: res => result.push(res)
      });
      return result;
    },
    select: function(path, from) {
      let result = this.selectAll(path, from);
      return !result.length ? null : result[0];
    },
    getPathArray: function(obj) {
      if (!obj[SYMBOL_PATH]) {
        return null;
      }

      return [...obj[SYMBOL_PATH]];
    },
    getPath: function(obj) {
      let arr = this.getPathArray(obj);
      if (!arr) {
        return null;
      }
      return JSONPath.toPathString(arr);
    },
    listen: function(path, callback) {
      this.futureListeners.delete(path);
      // First see if the path matches anything at this moment...
      let node = this.select(path);
      if (!node) {
        this.futureListeners.set(path, callback);
        return;
      }

      let normalizedPath = this.getPath(node);
      let listeners = this.listeners.get(normalizedPath);
      if (!listeners) {
        this.listeners.set(normalizedPath, listeners = new Set());
      }
      if (listeners.has(callback)) {
        return;
      }
      listeners.add(callback);
    },
    stop: function(path, callback) {
      if (this.futureListeners.has(path)) {
        this.futureListeners.delete(path);
      }

      let node = this.select(path);
      if (!node) {
        return;
      }

      let normalizedPath = this.getPath(node);
      let listeners = this.listeners.get(normalizedPath);
      if (!listeners) {
        return;
      }
      if (listeners.has(callback)) {
        listeners.delete(callback);
        if (!listeners.size) {
          this.listeners.delete(normalizedPath);
        }
      }
    },
    notify: function(op, target, prop, oldVal, newVal) {
      // console.log("NOTIFY!!", op, target, prop, oldVal, newVal);
      if (this.futureListeners.size) {
        for (let [path, callback] of this.futureListeners.entries()) {
          this.listen(path, callback);
        }
      }

      // Walk the tree to tell all listeners that something changed.
      let pathArr = this.getPathArray(target);
      let propPath = JSONPath.toPathString(pathArr.concat(prop));
      while (pathArr.length) {
        let path = JSONPath.toPathString(pathArr);
        if (this.listeners.has(path)) {
          for (let listener of this.listeners.get(path)) {
            listener(op, propPath, oldVal, newVal);
          }
        }
        pathArr.pop();
      }
    }
  };

  return modelImpl;

})();
