JSON.Model = (function() {

  const SYMBOL_PATH = "__path__";
  const SYMBOL_RAW = "__raw__";
  const RE_LASTPROP = /(\[(\d+)|['"`]{1}([^'"`]*)['"`]{1}\]$|\.([\w]+)$)/;
  const RE_ARRAYINDEX = /\[\d+\]$/;

  function modelImpl(json) {
    this.listeners = new Map();
    this.futureListeners = [];
    this.changeOrigin = null;
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
        if (prop == SYMBOL_RAW) {
          return target;
        }
        return target[prop];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop == SYMBOL_PATH || prop == SYMBOL_RAW) {
          return undefined;
        }
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
    load(json = {}) {
      json = json[SYMBOL_RAW] || json;
      if (typeof json != "object") {
        this.loadFrom(json);
        return;
      }
      // Let's get a fresh object to work with.
      json = Object.assign({}, json);

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
    loadFrom(url, method) {
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
    selectAll(path, from) {
      let result = [];
      try {
        JSONPath({
          path: path,
          json: from ? this.select(from) || this.data : this.data,
          resultType: "value",
          callback: res => result.push(res)
        });
      } catch (ex) {
        throw new SyntaxError(`There was in error in your JSONPath syntax: '${ex.message}' for path '${path}'`);
      }
      return result;
    },
    select(path, from) {
      let result = this.selectAll(path, from);
      return !result.length ? undefined : result[0];
    },
    change(path, value, origin) {
      if (this.select(path) === undefined) {
        console.error(`Invalid path, '${path}' did not match any nodes.`);
        return;
      }

      let propName, parentPath;
      path.replace(RE_LASTPROP, (m, fullProp, arrayIndex, propName1, propName2) => {
        parentPath = path.replace(fullProp, "");
        propName = arrayIndex || propName1 || propName2;
      });

      let parentNode = this.select(parentPath);
      if (!parentNode) {
        console.error(`Can not change the value of '${propName}' on node with path '${parentPath}'`);
        return;
      }
      this.changeOrigin = origin;
      parentNode[propName] = value;
      this.changeOrigin = null;
    },
    getPathArray(obj, originalPath) {
      if (typeof obj != "object" && originalPath) {
        // Try to rip off the last chunk of the path that points to the property,
        // which may look like '.propName', ['propName'] or '[42]'.
        let search = originalPath.replace(RE_LASTPROP, "");
        // If the regex didn't change anything to the path, well, we'll call
        // it a day.
        if (search == originalPath) {
          return null;
        }
        return this.getPathArray(this.select(search), search);
      }

      if (!obj[SYMBOL_PATH]) {
        return null;
      }
      return [...obj[SYMBOL_PATH]];
    },
    getPath(obj, originalPath) {
      let arr = this.getPathArray(obj, originalPath);
      if (!arr) {
        return null;
      }
      return JSONPath.toPathString(arr);
    },
    listen(path, callback) {
      // First see if the path matches anything at this moment...
      let node = this.select(path);
      if (node === undefined) {
        this.futureListeners.push([path, callback]);
        return;
      }

      let normalizedPath = this.getPath(node, path);
      // If the path is there and the original path doesn't end with an array
      // index getter specifically, strip it.
      if (normalizedPath && !RE_ARRAYINDEX.test(path)) {
        normalizedPath = normalizedPath.replace(RE_ARRAYINDEX, "");
      }
      if (!normalizedPath) {
        throw new Error(`model#listen failed: could not find path of existing node with path '${path}'`);
      }
      let listeners = this.listeners.get(normalizedPath);
      if (!listeners) {
        this.listeners.set(normalizedPath, listeners = new Map());
      }
      if (listeners.has(callback)) {
        return;
      }
      listeners.set(callback, path);
    },
    stop(path, callback) {
      for (let i = this.futureListeners.length; i >= 0; --i) {
        let [fPath, fCallback] = this.futureListeners[i];
        if (fPath == path && fCallback == callback) {
          this.futureListeners.splice(i, 1);
        }
      }

      let node = this.select(path);
      if (node === undefined) {
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
    notify(op, target, prop, oldVal, newVal) {
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
          this._notify(listeners, op, path, oldVal, newVal);
        }
        // Bail out, because there are no listeners left to find.
        return;
      }

      // Walk the tree upwards to tell all listeners that something changed.
      let pathArr = this.getPathArray(target);
      if (prop) {
        pathArr.push(prop);
      }
      let propPath = JSONPath.toPathString(pathArr);
      while (pathArr.length) {
        let path = JSONPath.toPathString(pathArr);
        this._notify(this.listeners.get(path), op, propPath, oldVal, newVal);
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
              if (this.listeners.has(propPath))
                this._notify(this.listeners.get(path), "delete", propPath, val, undefined);
            }
          }
        };
        
        notifyChildren(oldVal);
      }
    },
    _notify(listeners, ...args) {
      if (!listeners) {
        return;
      }

      for (let [listener, originalPath] of listeners) {
        if (this.changeOrigin === listener) {
          continue;
        }
        if (listener.handleBindingChange) {
          listener.handleBindingChange(originalPath, ...args);
        } else {
          listener(originalPath, ...args);
        }
      }
    }
  };

  return modelImpl;

})();
