(function () {
  "use strict";

  var configEl = document.getElementById("fn-split-ship-config");
  if (!configEl) return;

  var config;
  try {
    config = JSON.parse(configEl.textContent);
  } catch (err) {
    return;
  }

  var feeVariantId = Number(config.feeVariantId);
  var feeProductId = Number(config.feeProductId);
  if (!feeVariantId) {
    console.warn("[split-ship] Set split_ship_variant_id in snippets/split-ship-modal.liquid to the fee VARIANT id.");
    return;
  }

  var VENDOR_WEEK = String(config.vendors.oneWeek).toLowerCase();
  var VENDOR_NONSTOCK = String(config.vendors.nonStock).toLowerCase();
  var ATTR_KEY = config.attributeKey;
  var VAL_SPLIT = config.values.split;
  var VAL_DELAY = config.values.delay;
  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  var nativeFetch = window.fetch.bind(window);

  var dialog = document.getElementById("fn-split-ship-dialog");
  var form = document.getElementById("fn-split-ship-form");
  var submitBtn = document.getElementById("fn-split-ship-submit");
  var errorEl = document.getElementById("fn-split-ship-error");
  var statusTemplate = document.getElementById("fn-split-ship-status-template");
  if (!dialog || !form || !submitBtn || !errorEl) return;

  var state = {
    cart: null,
    syncing: false,
    applying: false,
    quiet: false,
    lastFeeAddAt: 0,
    syncTimer: null,
  };

  function routes() {
    return {
      cart: root + "cart.js",
      add: root + "cart/add.js",
      change: root + "cart/change.js",
      update: root + "cart/update.js",
    };
  }

  function isCartMutationUrl(url) {
    return /\/cart\/(add|change|update)/.test(String(url || ""));
  }

  function request(url, body) {
    state.quiet = true;
    return nativeFetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var message = data.description || data.message || "Cart request failed.";
            throw new Error(typeof message === "string" ? message : "Cart request failed.");
          }
          return data;
        });
      })
      .then(function (data) {
        state.quiet = false;
        return data;
      }, function (err) {
        state.quiet = false;
        throw err;
      });
  }

  function getCart() {
    state.quiet = true;
    return nativeFetch(routes().cart, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        state.quiet = false;
        return data;
      }, function (err) {
        state.quiet = false;
        throw err;
      });
  }

  function isFeeItem(item) {
    if (!item) return false;
    var variant = Number(item.variant_id || item.id);
    var product = Number(item.product_id);
    return variant === feeVariantId || product === feeProductId;
  }

  function isFeeAddEvent(product) {
    if (!product) return false;
    return (
      Number(product.variant_id) === feeVariantId ||
      Number(product.id) === feeVariantId ||
      Number(product.id) === feeProductId ||
      Number(product.product_id) === feeProductId
    );
  }

  function vendorOf(item) {
    return String(item.vendor || "").trim().toLowerCase();
  }

  function preferenceOf(cart) {
    var attrs = (cart && cart.attributes) || {};
    var value = attrs[ATTR_KEY];
    if (value === VAL_SPLIT || value === VAL_DELAY) return value;
    return "";
  }

  function classify(cart) {
    var hasWeek = false;
    var hasNonStock = false;
    var feeItem = null;
    (cart.items || []).forEach(function (item) {
      if (isFeeItem(item)) {
        feeItem = item;
        return;
      }
      var vendor = vendorOf(item);
      if (vendor === VENDOR_WEEK) hasWeek = true;
      if (vendor === VENDOR_NONSTOCK) hasNonStock = true;
    });
    return {
      mixed: hasWeek && hasNonStock,
      feeItem: feeItem,
      preference: preferenceOf(cart),
    };
  }

  function setError(message) {
    if (!message) {
      errorEl.textContent = "";
      errorEl.classList.remove("is-visible");
      return;
    }
    errorEl.textContent = message;
    errorEl.classList.add("is-visible");
  }

  function focusables(container) {
    return Array.prototype.slice
      .call(
        container.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      )
      .filter(function (el) {
        return el.offsetParent !== null || el === document.activeElement;
      });
  }

  function setInert(on) {
    Array.prototype.forEach.call(document.body.children, function (child) {
      if (child === dialog) return;
      if (on) child.setAttribute("inert", "");
      else child.removeAttribute("inert");
    });
  }

  function clearThemeLoading() {
    document.documentElement.classList.remove("js-loading", "ajax-loading", "is-loading");
    document.body.classList.remove("js-loading", "ajax-loading", "is-loading", "overflow-hidden");
    var overlays = document.querySelectorAll(
      ".loading-overlay, .loading-bar, .ajax-loading, [data-loading-overlay], .page-overlay, .loading-spinner"
    );
    Array.prototype.forEach.call(overlays, function (el) {
      el.classList.add("hidden");
      el.classList.remove("is-active", "is-loading", "active", "open");
      el.setAttribute("hidden", "");
      el.style.display = "none";
    });
  }

  function openDialog(preselect) {
    setError("");
    var radios = form.querySelectorAll('input[name="fn-split-ship-choice"]');
    Array.prototype.forEach.call(radios, function (radio) {
      radio.checked = preselect ? radio.value === preselect : false;
    });
    submitBtn.disabled = !preselect;
    dialog.hidden = false;
    dialog.classList.add("is-open");
    dialog.setAttribute("aria-hidden", "false");
    setInert(true);
    var first = form.querySelector('input[name="fn-split-ship-choice"]');
    if (first) first.focus();
  }

  function closeDialog() {
    dialog.classList.remove("is-open");
    dialog.hidden = true;
    dialog.setAttribute("aria-hidden", "true");
    setInert(false);
    setError("");
  }

  function selectedChoice() {
    var checked = form.querySelector('input[name="fn-split-ship-choice"]:checked');
    return checked ? checked.value : "";
  }

  function cartSignature(cart) {
    var items = (cart.items || []).map(function (item) {
      return [item.variant_id || item.id, item.quantity, item.key];
    });
    return JSON.stringify({ items: items, attributes: cart.attributes || {} });
  }

  function notifyTheme() {
    document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true, detail: { open: false } }));
    clearThemeLoading();
    if (/\/cart\/?$/.test(window.location.pathname)) {
      window.location.reload();
    }
  }

  function setAttributes(value) {
    var attrs = {};
    attrs[ATTR_KEY] = value == null ? "" : value;
    return request(routes().update, { attributes: attrs }).then(function () {
      return getCart();
    });
  }

  function addFee(cart) {
    if (cart && classify(cart).feeItem) return Promise.resolve(cart);
    if (Date.now() - state.lastFeeAddAt < 2000) return getCart();
    state.lastFeeAddAt = Date.now();
    return request(routes().add, {
      items: [{ id: feeVariantId, quantity: 1 }],
    }).then(function () {
      return getCart();
    });
  }

  function removeFee(item) {
    if (!item) return getCart();
    return request(routes().change, { id: item.key, quantity: 0 }).then(function () {
      return getCart();
    });
  }

  function setFeeQuantity(item, quantity) {
    return request(routes().change, { id: item.key, quantity: quantity }).then(function () {
      return getCart();
    });
  }

  function applyChoice(choice) {
    state.applying = true;
    submitBtn.disabled = true;
    closeDialog();
    var preference = choice === "split" ? VAL_SPLIT : VAL_DELAY;
    return setAttributes(preference)
      .then(function (cart) {
        state.cart = cart;
        var info = classify(cart);
        if (choice === "split") {
          if (!info.feeItem) return addFee(cart);
          if (info.feeItem.quantity !== 1) return setFeeQuantity(info.feeItem, 1);
          return cart;
        }
        if (info.feeItem) return removeFee(info.feeItem);
        return cart;
      })
      .then(function (cart) {
        state.cart = cart;
        paint(cart);
        notifyTheme();
      })
      .catch(function (err) {
        openDialog(choice);
        setError(err.message || "Could not save that choice. Try again.");
        submitBtn.disabled = !selectedChoice();
      })
      .then(function () {
        state.applying = false;
        clearThemeLoading();
      });
  }

  function reconcile(cart) {
    var info = classify(cart);
    if (state.applying) return Promise.resolve(cart);

    if (!info.mixed) {
      var tasks = Promise.resolve(cart);
      if (info.preference) {
        tasks = tasks.then(function () {
          return setAttributes("");
        });
      }
      if (info.feeItem) {
        tasks = tasks.then(function (next) {
          return removeFee(classify(next).feeItem || info.feeItem);
        });
      }
      return tasks;
    }

    if (info.preference === VAL_SPLIT) {
      if (!info.feeItem) return addFee(cart);
      if (info.feeItem.quantity > 1) return setFeeQuantity(info.feeItem, 1);
      return Promise.resolve(cart);
    }

    if (info.preference === VAL_DELAY && info.feeItem) {
      return removeFee(info.feeItem);
    }

    return Promise.resolve(cart);
  }

  function hideWallets(hide) {
    document.body.classList.toggle("fn-split-ship-hide-wallets", hide);
  }

  function hideNode(el) {
    if (!el || el.nodeType !== 1) return;
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.setAttribute("hidden", "");
    el.setAttribute("tabindex", "-1");
    el.setAttribute("aria-hidden", "true");
    if ("disabled" in el) el.disabled = true;
  }

  function closestCartRow(el) {
    if (!el || !el.closest) return null;
    return el.closest(
      ".mini-cart__item, .cart-item, .cart-drawer-item, .drawer-cart-item, [id^='CartItem-'], [id^='CartDrawer-Item-'], [data-line-item-index], [data-variant-id], tr, li"
    );
  }

  function rowMatchesFee(row, feeItems) {
    if (!row || !feeItems.length) return false;
    var html = "";
    try {
      html = String(row.outerHTML || "");
    } catch (err) {
      html = "";
    }
    return feeItems.some(function (item) {
      var variant = String(item.variant_id || item.id);
      var key = String(item.key || "");
      var handle = String(item.handle || "");
      if (row.getAttribute("data-variant-id") === variant) return true;
      if (row.getAttribute("data-product-id") === String(feeProductId)) return true;
      if (row.querySelector('[data-variant-id="' + variant + '"]')) return true;
      if (key && row.querySelector('[name="updates[' + key + ']"]')) return true;
      if (handle && row.querySelector('a[href*="/products/' + handle + '"]')) return true;
      if (html.indexOf(variant) !== -1) return true;
      if (key && html.indexOf(key) !== -1) return true;
      if (handle && html.indexOf("/products/" + handle) !== -1) return true;
      return false;
    });
  }

  function feeControlsSelector() {
    return [
      ".quantity",
      "quantity-input",
      ".quantity-selector",
      ".qty",
      ".qty-selector",
      ".qty-input",
      ".mini-cart__quantity",
      ".cart-item__quantity",
      ".cart-quantity",
      ".product-form__quantity",
      "[name^='updates']",
      "button[name='minus']",
      "button[name='plus']",
      "[data-action='minus']",
      "[data-action='plus']",
      "[data-quantity-minus]",
      "[data-quantity-plus]",
      ".quantity__button",
      "cart-remove-button",
      ".cart-remove",
      ".cart-item__remove",
      ".mini-cart__remove",
      "[data-remove]",
      "[data-action='remove']",
      "a[href*='/cart/change']",
      "button[aria-label*='emove']",
      "a[aria-label*='emove']",
    ].join(",");
  }

  function markAndLockRow(row) {
    if (!row || row.nodeType !== 1) return;
    row.classList.add("fn-split-ship-fee-line");
    row.setAttribute("data-fn-split-ship-fee", "true");
    Array.prototype.forEach.call(row.querySelectorAll(feeControlsSelector()), hideNode);
  }

  function lockFeeLine(cart) {
    var feeItems = (cart.items || []).filter(isFeeItem);
    Array.prototype.forEach.call(document.querySelectorAll("[data-fn-split-ship-fee]"), function (row) {
      if (!rowMatchesFee(row, feeItems)) {
        row.classList.remove("fn-split-ship-fee-line");
        row.removeAttribute("data-fn-split-ship-fee");
      }
    });
    if (!feeItems.length) return;

    var candidates = document.querySelectorAll(
      ".mini-cart__item, .cart-item, .cart-drawer-item, [id^='CartItem-'], [id^='CartDrawer-Item-'], tr.cart-item, [data-line-item-index], li"
    );
    Array.prototype.forEach.call(candidates, function (row) {
      if (rowMatchesFee(row, feeItems)) markAndLockRow(row);
    });

    feeItems.forEach(function (item) {
      var variant = String(item.variant_id || item.id);
      var key = String(item.key || "");
      var handle = String(item.handle || "");
      var needles = [];
      if (handle) needles.push('a[href*="/products/' + handle + '"]');
      needles.push('a[href*="' + variant + '"]');
      needles.push('[data-variant-id="' + variant + '"]');
      needles.push('[data-product-id="' + feeProductId + '"]');
      if (key) needles.push('[name="updates[' + key + ']"]');
      document.querySelectorAll(needles.join(",")).forEach(function (node) {
        markAndLockRow(closestCartRow(node) || node);
        if (node.matches && (node.matches("a[href*='/cart/change']") || node.matches(feeControlsSelector()))) {
          hideNode(node);
        }
      });
    });
  }

  function feeLineNumber(cart) {
    var items = cart && cart.items ? cart.items : [];
    for (var i = 0; i < items.length; i++) {
      if (isFeeItem(items[i])) return i + 1;
    }
    return 0;
  }

  function isFeeQtyChange(url, init) {
    if (!/\/cart\/(change|update)/.test(String(url || ""))) return false;
    var fee = state.cart && classify(state.cart).feeItem;
    if (!fee) return false;
    var variant = String(fee.variant_id || fee.id);
    var key = String(fee.key || "");
    var line = String(feeLineNumber(state.cart));
    var body = "";
    if (init && init.body) {
      if (typeof init.body === "string") body = init.body;
      else if (typeof FormData !== "undefined" && init.body instanceof FormData) {
        var parts = [];
        init.body.forEach(function (value, name) {
          parts.push(name + "=" + value);
        });
        body = parts.join("&");
      }
    }
    var blob = String(url) + " " + body;
    if (blob.indexOf(variant) !== -1 || (key && blob.indexOf(key) !== -1)) return true;
    if (line && (blob.indexOf("line=" + line) !== -1 || blob.indexOf('"line":' + line) !== -1)) return true;
    return false;
  }

  function statusCopy(preferenceKey) {
    if (preferenceKey === "split") {
      return {
        title: "Shipment: Split — $5 charge",
        detail: "Ready items ship now. Other items ship when they are available.",
      };
    }
    return {
      title: "Shipment: Delay until complete",
      detail: "No extra charge. We hold everything until all items are ready, then send one package.",
    };
  }

  function fillStatusNode(node, copy) {
    var title = node.querySelector("[data-fn-split-ship-status-title]");
    var detail = node.querySelector("[data-fn-split-ship-status-text]");
    if (title) title.textContent = copy.title;
    if (detail) detail.textContent = copy.detail;
    node.hidden = false;
  }

  function statusMounts() {
    var mounts = [];
    var seen = [];
    function add(node, mode) {
      if (!node || seen.indexOf(node) !== -1) return;
      seen.push(node);
      mounts.push({ node: node, mode: mode || "prepend" });
    }
    add(document.getElementById("main-cart-footer"), "prepend");
    add(document.querySelector("#main-cart-footer .js-contents"), "prepend");
    add(document.querySelector(".cart-footer"), "prepend");
    add(document.querySelector(".cart__footer"), "prepend");
    add(document.querySelector(".mini-cart__footer"), "prepend");
    add(document.querySelector(".cart-drawer__footer"), "prepend");
    add(document.querySelector(".drawer__footer"), "prepend");
    add(document.getElementById("CartDrawer-Checkout"), "before");
    add(document.querySelector('form#cart [name="checkout"]'), "before");
    add(document.querySelector('.mini-cart [name="checkout"]'), "before");
    add(document.querySelector('.mini-cart__footer .button'), "before");
    add(document.querySelector("#main-cart-items .js-contents"), "append");
    add(document.querySelector(".mini-cart__items"), "append");
    add(document.querySelector("form#cart"), "append");
    add(document.querySelector(".mini-cart__inner"), "prepend");
    add(document.getElementById("CartDrawer"), "prepend");
    return mounts;
  }

  function insertStatusLine(visible, preferenceKey) {
    var existing = document.querySelectorAll("[data-fn-split-ship-status]");
    if (!visible) {
      Array.prototype.forEach.call(existing, function (el) {
        el.remove();
      });
      return;
    }
    var copy = statusCopy(preferenceKey);
    if (existing.length) {
      Array.prototype.forEach.call(existing, function (el) {
        fillStatusNode(el, copy);
      });
      return;
    }
    if (!statusTemplate || !statusTemplate.firstElementChild) return;
    var used = [];
    statusMounts().forEach(function (mount) {
      var host = mount.node;
      if (!host || used.indexOf(host) !== -1) return;
      if (host.closest && host.closest("[data-fn-split-ship-status]")) return;
      if (host.querySelector && host.querySelector("[data-fn-split-ship-status]")) return;
      var node = statusTemplate.firstElementChild.cloneNode(true);
      fillStatusNode(node, copy);
      if (mount.mode === "before" && host.parentNode) {
        host.parentNode.insertBefore(node, host);
      } else if (mount.mode === "append") {
        host.appendChild(node);
      } else {
        host.insertBefore(node, host.firstChild);
      }
      used.push(host);
    });
  }

  function paint(cart) {
    var info = classify(cart);
    lockFeeLine(cart);
    hideWallets(info.mixed && !info.preference);
    insertStatusLine(info.mixed && !!info.preference, info.preference === VAL_SPLIT ? "split" : "delay");
    if (info.mixed && !info.preference) {
      if (!dialog.classList.contains("is-open")) openDialog("");
    } else if (!info.mixed) {
      closeDialog();
    }
  }

  function sync() {
    if (state.syncing || state.applying) return;
    state.syncing = true;
    getCart()
      .then(function (cart) {
        var before = cartSignature(cart);
        return reconcile(cart).then(function (next) {
          return { cart: next, changed: cartSignature(next) !== before };
        });
      })
      .then(function (result) {
        state.cart = result.cart;
        paint(result.cart);
        if (result.changed) notifyTheme();
      })
      .catch(function (err) {
        console.warn("[split-ship]", err);
      })
      .then(function () {
        state.syncing = false;
        clearThemeLoading();
      });
  }

  function scheduleSync() {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(sync, 250);
  }

  form.addEventListener("change", function () {
    submitBtn.disabled = !selectedChoice();
    setError("");
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var choice = selectedChoice();
    if (!choice) {
      setError("Choose how this order should ship.");
      return;
    }
    applyChoice(choice);
  });

  dialog.addEventListener("keydown", function (event) {
    if (!dialog.classList.contains("is-open")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      return;
    }
    if (event.key !== "Tab") return;
    var items = focusables(dialog);
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener(
    "change",
    function (event) {
      var input = event.target;
      if (!input || !input.matches || !input.matches("[name^='updates'], .quantity__input, .qty-input, input[type='number']")) {
        return;
      }
      var row = closestCartRow(input);
      var feeItems = ((state.cart && state.cart.items) || []).filter(isFeeItem);
      if (row && (row.classList.contains("fn-split-ship-fee-line") || rowMatchesFee(row, feeItems))) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "1";
        scheduleSync();
      }
    },
    true
  );

  document.addEventListener(
    "click",
    function (event) {
      var changeBtn = event.target.closest && event.target.closest("[data-fn-split-ship-change]");
      if (changeBtn) {
        event.preventDefault();
        event.stopPropagation();
        var current = classify(state.cart || { items: [], attributes: {} });
        var preselect =
          current.preference === VAL_SPLIT ? "split" : current.preference === VAL_DELAY ? "delay" : "";
        openDialog(preselect);
        return;
      }

      var control = event.target.closest && event.target.closest(feeControlsSelector());
      if (control) {
        var row = closestCartRow(control) || event.target.closest(".fn-split-ship-fee-line");
        var href = (control.getAttribute && control.getAttribute("href")) || control.href || "";
        var feeItems = ((state.cart && state.cart.items) || []).filter(isFeeItem);
        var hrefHitsFee = feeItems.some(function (item) {
          var variant = String(item.variant_id || item.id);
          return href.indexOf(variant) !== -1 || (item.handle && href.indexOf("/products/" + item.handle) !== -1);
        });
        if ((row && (row.classList.contains("fn-split-ship-fee-line") || rowMatchesFee(row, feeItems))) || hrefHitsFee) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      var addLike = event.target.closest(
        'form[action*="/cart/add"] button, form[action*="/cart/add"] input[type="submit"], [name="add"], [data-add-to-cart], .product-form__submit, .quick-add__submit'
      );
      if (addLike && !event.target.closest("#fn-split-ship-form")) {
        setTimeout(scheduleSync, 400);
      }

      var info = classify(state.cart || { items: [], attributes: {} });
      if (!(info.mixed && !info.preference)) return;
      var checkoutLike = event.target.closest(
        'button[name="checkout"], input[name="checkout"], a[href*="/checkout"], #CartDrawer-Checkout, .cart__checkout-button'
      );
      if (!checkoutLike) return;
      event.preventDefault();
      event.stopPropagation();
      openDialog("");
    },
    true
  );

  document.addEventListener(
    "submit",
    function (event) {
      var formEl = event.target;
      if (formEl && formEl.id === "fn-split-ship-form") return;
      if (formEl && formEl.action && /\/cart\/add/.test(formEl.action)) {
        setTimeout(scheduleSync, 400);
      }
      var info = classify(state.cart || { items: [], attributes: {} });
      if (!(info.mixed && !info.preference)) return;
      if (!formEl || !formEl.querySelector || !formEl.querySelector('[name="checkout"]')) return;
      event.preventDefault();
      event.stopPropagation();
      openDialog("");
    },
    true
  );

  document.addEventListener("ajaxProduct:added", function (event) {
    if (isFeeAddEvent(event.detail && event.detail.product)) {
      clearThemeLoading();
      return;
    }
    scheduleSync();
  });

  document.addEventListener("cart:updated", function (event) {
    if (event.detail && event.detail.source === "fn-split-ship") return;
    scheduleSync();
  });

  document.addEventListener("page:loaded", scheduleSync);

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (!state.quiet && isFeeQtyChange(url, init)) {
      scheduleSync();
      clearThemeLoading();
      return Promise.resolve(
        new Response(JSON.stringify({ status: 200, message: "ok", description: "Split shipping quantity is locked." }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return nativeFetch(input, init).then(function (res) {
      if (!state.quiet && !state.applying && isCartMutationUrl(url)) {
        scheduleSync();
      }
      return res;
    });
  };

  (function patchXhr() {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._fnSplitShipUrl = url;
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var url = this._fnSplitShipUrl || "";
      if (!state.quiet && isFeeQtyChange(url, { body: body })) {
        scheduleSync();
        clearThemeLoading();
        this.abort();
        return;
      }
      return send.apply(this, arguments);
    };
  })();

  var observerTimer = null;
  var observer = new MutationObserver(function () {
    if (!state.cart) return;
    clearTimeout(observerTimer);
    observerTimer = setTimeout(function () {
      var info = classify(state.cart);
      lockFeeLine(state.cart);
      insertStatusLine(info.mixed && !!info.preference, info.preference === VAL_SPLIT ? "split" : "delay");
    }, 80);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    scheduleSync();
  } else {
    document.addEventListener("DOMContentLoaded", scheduleSync);
  }
})();
