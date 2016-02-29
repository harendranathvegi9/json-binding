JSON.Model = (function() {

  const SYMBOL_PATH = "__path__";

  function modelImpl(json) {
    this.listeners = new Map();
    this.futureListeners = new Map();
    this.load(json);
  };

  function getObjectProxy(obj, path, model) {
    let isArray = Array.isArray(obj);
    let keys = isArray ? obj : Object.getOwnPropertyNames(obj);
    let count = 0;
    let val, key;
    for (let i of keys) {
      val = isArray ? i : obj[i];
      key = isArray ? count : i;
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
      if (typeof json != "object") {
        this.loadFrom(json);
        return;
      }

      // TODO: Allow extending model with sub-path parameter.
      for (let prop of Object.getOwnPropertyNames(json)) {
        if (typeof json[prop] == "object") {
          json[prop] = getObjectProxy(json[prop], ["$", prop], this);
        }
      }
      json[SYMBOL_PATH] = ["$"];
      this.data = getGenericProxy(json, this);
    },
    loadFrom: function(url, method) {
      // TODO: Allow this method to be used in NodeJS too.
      return new Promise((resolve, reject) => {
        if (url instanceof URL) {
          url = url.href;
        }

        try {
          if (typeof url != "string") {
            throw url;
          }
          if (url.indexOf("//:") > -1) {
            new URL(url);
          }
        } catch (ex) {
          reject(new Error("model#loadFrom failed: Please pass a valid URL, instead of " + url));
          return;
        }

        if (this._xhr) {
          reject(new Error("model#loadFrom failed: We're already attempting to load data. Please hold."));
          return;
        }

        let req = this._xhr = new XMLHttpRequest();
        req.open(method || "GET", url, true);
        req.responseType = "json";
        req.onload = () => {
          delete this._xhr;

          if (req.status < 200 || req.status >= 300) {
            reject(new Error("model#loadFrom failed: " + req.status + " " + req.statusText));
            return;
          }

          this.load(req.response);
          resolve();
        };
        req.send(null);
      });
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
      if (!normalizedPath) {
        throw new Error("model#listen failed: could not find path of existing node");
      }
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
      if (!normalizedPath) {
        throw new Error("model#stop failed: could not find path of existing node");
      }
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
      if (this.futureListeners.size) {
        for (let [path, callback] of this.futureListeners.entries()) {
          this.listen(path, callback);
        }
      }

      // Walk the tree upwards to tell all listeners that something changed.
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

      // Delete operations require child nodes listener to also be notified.
      // Another case would be when a property changes from an object to a
      // non-object (scalar value or 'null'), which invalidates all child nodes.
      if (op == "delete" || (typeof oldVal == "object" && typeof newVal != "object")) {
        const notifyChildren = obj => {
          let isArray = Array.isArray(obj);
          pathArr = this.getPathArray(obj);
          let keys = isArray ? obj : Object.getOwnPropertyNames(obj);
          let count = 0;
          let val, key;
          for (let i of keys) {
            val = isArray ? i : obj[i];
            key = isArray ? count : i;
            if (typeof val == "object") {
              notifyChildren(val);
            } else {
              propPath = JSONPath.toPathString(pathArr.concat(key));
              if (this.listeners.has(propPath)) {
                for (let listener of this.listeners.get(path)) {
                  listener("delete", propPath, val, undefined);
                }
              }
            }
          }
        };
        
        notifyChildren(oldVal);
      }
    }
  };

  return modelImpl;

})();
