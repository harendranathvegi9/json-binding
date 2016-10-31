JSON.bind = (function(global) {

  const kBindingAttrName = "data-binding";
  const kREPathStart = /^(\{|\[)/;
  const kREPathEnd = /(\}|\])$/;
  const kREAttributeParser = /^(\{|\[)?([^\{\[\}\]\.\$@#:\?\(\)]*)?(::)?(.*)?(\}|\])?$/;
  const kFormElements = "button|datalist|fieldset|form|input|keygen|label|legend|meter|optgroup|option|output|progress|select";
  const kNodePropName = "__node__"

  let boundElements = new WeakMap();

  function extractBindingData(attrValue) {
    let modelName = null;
    let path = null;
    let stereo = false;

    attrValue.replace(kREAttributeParser, (m, pathStart, modelDecl, connector, pathPart, pathEnd) => {
      // The path-matching part may be too greedy, so fix it up here.
      if (pathStart && !pathEnd) {
        pathPart = pathPart || "";
        let m = pathPart.match(kREPathEnd);
        pathEnd = m && m[1];
        pathPart = pathPart.replace(kREPathEnd, "");
      }

      if ((pathStart || pathEnd) && (!pathStart || !pathEnd || pathEnd.charCodeAt(0) - pathStart.charCodeAt(0) != 2)) {
        let expected = !pathStart && !pathEnd ? "{ or [" :
          !pathStart ? pathEnd == "}" ? "{" : "[" : pathStart == "{" ? "}" : "]";
        throw new SyntaxError("Path specified without the proper start or end " +
          `delimiters in '${attrValue}'. Expected '${expected}'.`);
      }

      modelName = modelDecl || "";
      path = pathPart;
      stereo = !!pathStart && pathStart == "[";
    });

    return { modelName, path, stereo };
  }

  function bind(el) {
    // Check if we got in a Window object.
    let document;
    if ("btoa" in el) {
      document = el.document;
      el = document.documentElement;
    } else if ("documentElement" in el) {
      document = el;
      el = el.documentElement;
    } else {
      document = el.ownerDocument;
    }

    let result = document.evaluate(`//node()[@${kBindingAttrName}]`, el, null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    while (el = result.iterateNext()) {
      let binding = el.getAttribute(kBindingAttrName);
      let bindingData = extractBindingData(binding);
      let model = global[bindingData.modelName];
      if (!model) {
        model = global[bindingData.modelName] = new JSON.Model();
      }

      // Wrap the appropriate binding rule.
      if (kFormElements.includes(el.localName)) {
        new FormElementBinding(el, model, bindingData);
      }
    }
  }

  class FormElementBinding {
    constructor(el, model, bindingData) {
      this.el = el;
      this.model = model;
      this.bindingData = bindingData;
      this.type = this.el.localName;
      this._dynamicProperties = {};

      setTimeout(() => this.connect(), 0);
    }

    connect() {
      // Initialize the element and do something with the initial dataset.
      let bindingData;
      if (this.type == "progress") {
        // Eligible properties are: 'value' and 'max'.
        let value = this.el.getAttribute("value") || "";
        bindingData = extractBindingData(value);
        if (!bindingData.path) {
          throw new TypeError("Data-bound <progress> element does not use " +
            `dynamic properties: '${value}'.`);
        }
        this._dynamicProperties.value = bindingData;
        this.model.listen(bindingData.path, this);

        let max = this.el.getAttribute("max") || "";
        bindingData = extractBindingData(value);
        if (bindingData.path) {
          this._dynamicProperties.max = bindingData;
          this.model.listen(bindingData.path, this);
        }
      } else if (this.type == "select") {
        // Eligible properties are 'data-options' and 'data-option-value' and 'data-option-text'.
        for (let prop of ["data-options", "data-option-value", "data-option-text"]) {
          let val = this.el.getAttribute(prop) || "";
          bindingData = extractBindingData(val);
          if (!bindingData.path)
            throw new Error(`Missing required attribute '${prop}'`);
          this._dynamicProperties[prop] = bindingData;
          this.model.listen(bindingData.path, this);
        }
        let onChange = this.el.getAttribute("onchange");
        onChange = onChange && onChange.replace(/\(.*$/, "");
        if (onChange && global[onChange]) {
          this.onChange = global[onChange];
          this.el.removeAttribute("onchange");
        }
        this.el.addEventListener("change", this, false);
      }

      this.update();
      this.handleEvent({ type: "change" });
    }

    update() {
      if (this.type == "progress") {
        for (let prop of Object.getOwnPropertyNames(this._dynamicProperties)) {
          let bindingData = this._dynamicProperties[prop];
          let res = this.model.selectAll(bindingData.path);
          if (!res[0])
            continue;
          this.el.setAttribute(prop, res[0]);
        }
      } else if (this.type == "select") {
        let bindingData = this._dynamicProperties["data-options"];
        let res = this.model.selectAll(bindingData.path);
        let valueBinding = this._dynamicProperties["data-option-value"];
        let textBinding = this._dynamicProperties["data-option-text"];
        this.el.innerHTML = "";
        for (let node of res) {
          let value, text;
          JSONPath({
            path: valueBinding.path,
            json: node,
            resultType: "value",
            callback: ret => value = ret
          });
          JSONPath({
            path: textBinding.path,
            json: node,
            resultType: "value",
            callback: ret => text = ret
          });
          let option = this.el.ownerDocument.createElement("option");
          option.value = value;
          option.text = text;
          option[kNodePropName] = node;
          this.el.appendChild(option);
        }
      }
    }

    disconnect() {
      // TODO: call this from somewhere.
      for (let prop of Object.getOwnPropertyNames(this._dynamicProperties)) {
        let bindingData = this._dynamicProperties[prop];
        this.model.stop(bindingData.path, this);
      }
      if (this.type == "select")
        this.el.removeEventListener("change", this);
    }

    handleEvent(ev) {
      if (ev.type != "change")
        return;
      if (this.type == "select") {
        if (this.onChange) {
          ev.node = this.el.item(this.el.selectedIndex)[kNodePropName];
          this.onChange.call(this, ev);
        }
      }
    }

    onBindingChange(changeType, path, oldVal, newVal) {
      for (let prop of Object.getOwnPropertyNames(this._dynamicProperties)) {
        let bindingData = this._dynamicProperties[prop];
        if (bindingData.path != path)
          continue;
        if (this.type == "progress") {
          if (prop == "value")
            this.el.setAttribute("value", newVal);
        }
      }
    }
  }

  return bind;
})(this);
