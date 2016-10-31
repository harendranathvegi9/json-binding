JSON.Model = (function() {

  const SYMBOL_PATH = "__path__";
  const SYMBOL_RAW = "__raw__";

  function modelImpl(json) {
    this.listeners = new Map();
    this.futureListeners = [];
    this.load(json);
  };

  function getObjectProxy(obj, path, model) {
    let isArray = Array.isArray(obj);
    let keys = isArray ? obj : Object.getOwnPropertyNames(obj).filter(val => val != SYMBOL_PATH);
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
      get(target, prop) {
        if (prop == SYMBOL_RAW)
          return target;
        return target[prop];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop == SYMBOL_PATH || prop == SYMBOL_RAW)
          return undefined;
        return Object.getOwnPropertyDescriptor(target, prop);
      },
      defineProperty(target, prop, desc) {
        // Let's not allow defineProperty, to avoid unnecessary complexity.
        return false;
      },
      deleteProperty(target, prop) {
        let oldVal = target[prop];
        delete target[prop];

        model.notify("delete", target, prop, oldVal);
      },
      enumerate(target) {
        return Object.getOwnPropertyNames(target).filter(val => val != SYMBOL_PATH);
      },
      has(target, prop) {
        if (prop == SYMBOL_PATH)
          return false;
        return prop in target;
      },
      ownKeys(target) {
        return Object.getOwnPropertyNames(target).filter(val => val != SYMBOL_PATH);
      },
      preventExtensions(target) {
        // noop.
      },
      set(target, prop, newVal) {
        if (prop == SYMBOL_PATH || prop == SYMBOL_RAW) {
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
      setPrototypeOf(target, proto) {
        // noop.
      }
    })
  }

  modelImpl.prototype = {
    load: function(json = {}) {
      json = json[SYMBOL_RAW] || json;
      if (typeof json != "object") {
        this.loadFrom(json);
        return;
      }

      // TODO: Allow extending model with sub-path parameter.
      for (let prop of Object.getOwnPropertyNames(json)) {
        if (prop != SYMBOL_PATH && typeof json[prop] == "object") {
          json[prop] = getObjectProxy(json[prop], ["$", prop], this);
        }
      }
      json[SYMBOL_PATH] = ["$"];
      this.data = getGenericProxy(json, this);
      setTimeout(() => this.notify("load", this.data), 0);
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
    hasListener(path, callback) {
      if (!this.listeners.has(path))
        return false;
      return this.listeners.get(path).has(listener);
    },
    listen: function(path, callback) {
      // First see if the path matches anything at this moment...
      let node = this.select(path);
      if (!node) {
        if (!this.hasListener(path, callback))
          this.futureListeners.push([path, callback]);
        return;
      }

      let normalizedPath = typeof node == "object" ? this.getPath(node) : path;
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
      for (let i = this.futureListeners.length; i >= 0; --i) {
        let [fPath, fCallback] = this.futureListeners[i];
        if (fPath == path && fCallback == callback)
          this.futureListeners.splice(i, 1);
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
      let len = this.futureListeners.length;
      if (len) {
        let listeners = [...this.futureListeners];
        this.futureListeners = [];
        for (let i = 0; i < len; ++i) {
          this.listen(listeners[i][0], listeners[i][1]);
        }
      }

      // Loads are simple. All data has been refreshed, so we can invoke all
      // active listeners.
      if (op == "load") {
        for (let [path, listeners] of this.listeners) {
          newVal = this.select(path);
          for (let listener of listeners) {
            if (listener.onBindingChange)
              listener.onBindingChange(op, path, oldVal, newVal);
            else
              listener(op, path, oldVal, newVal);
          }
        }
        // Bail out, because there are no listeners left to find.
        return;
      }

      // Walk the tree upwards to tell all listeners that something changed.
      let pathArr = this.getPathArray(target);
      let propPath = JSONPath.toPathString(pathArr.concat(prop || []));
      while (pathArr.length) {
        let path = JSONPath.toPathString(pathArr);
        if (this.listeners.has(path)) {
          for (let listener of this.listeners.get(path)) {
            if (listener.onBindingChange)
              listener.onBindingChange(op, propPath, oldVal, newVal);
            else
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
                  (listener.onBindingChange || listener)("delete", propPath, val, undefined);
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
