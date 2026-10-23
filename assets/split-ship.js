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
  if (!feeVariantId) {
    console.warn("[split-ship] Set the fee VARIANT id in snippets/split-ship-fee-id.liquid.");
    return;
  }

  var VENDOR_WEEK = String(config.vendors.oneWeek).trim().toLowerCase();
  var VENDOR_NONSTOCK = String(config.vendors.nonStock).trim().toLowerCase();
  var ATTR_KEY = config.attributeKey;
  var VAL_SPLIT = config.values.split;
  var VAL_TOGETHER = config.values.together;
  var COPY = config.copy;
  var DRAWER_SECTIONS = ["mini-cart", "cart-icon-bubble", "mobile-cart-icon-bubble"];
  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  var nativeFetch = window.fetch.bind(window);

  var dialog = document.getElementById("fn-split-ship-dialog");
  var form = document.getElementById("fn-split-ship-form");
  var submitBtn = document.getElementById("fn-split-ship-submit");
  var errorEl = document.getElementById("fn-split-ship-error");
  var statusTemplate = document.getElementById("fn-split-ship-status-template");
  if (!dialog || !form || !submitBtn || !errorEl) return;
  var submitLabel = submitBtn.textContent;

  var state = {
    cart: null,
    syncing: false,
    applying: false,
    lastFeeAddAt: 0,
    syncTimer: null,
  };

  var routes = {
    cart: root + "cart.js",
    add: root + "cart/add.js",
    change: root + "cart/change.js",
    update: root + "cart/update.js",
  };

  function isCartPage() {
    return /\/cart\/?$/.test(window.location.pathname);
  }

  function isCartMutationUrl(url) {
    return /\/cart\/(add|change|update|clear)/.test(String(url || ""));
  }

  function request(url, body) {
    return nativeFetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var message = data.description || data.message || "Cart request failed.";
          throw new Error(typeof message === "string" ? message : "Cart request failed.");
        }
        return data;
      });
    });
  }

  function getCart() {
    return nativeFetch(routes.cart, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(
      function (res) {
        return res.json();
      }
    );
  }

  function isFeeItem(item) {
    return !!item && Number(item.variant_id || item.id) === feeVariantId;
  }

  function vendorOf(item) {
    return String(item.vendor || "").trim().toLowerCase();
  }

  function preferenceOf(cart) {
    var value = ((cart && cart.attributes) || {})[ATTR_KEY];
    if (value === VAL_SPLIT || value === VAL_TOGETHER) return value;
    return "";
  }

  function classify(cart) {
    var hasWeek = false;
    var hasNonStock = false;
    var feeItem = null;
    ((cart && cart.items) || []).forEach(function (item) {
      if (isFeeItem(item)) {
        feeItem = item;
        return;
      }
      var vendor = vendorOf(item);
      if (vendor === VENDOR_WEEK) hasWeek = true;
      if (vendor === VENDOR_NONSTOCK) hasNonStock = true;
    });
    return { mixed: hasWeek && hasNonStock, feeItem: feeItem, preference: preferenceOf(cart) };
  }

  function choiceOf(preference) {
    if (preference === VAL_SPLIT) return "split";
    if (preference === VAL_TOGETHER) return "together";
    return "";
  }

  /* Modal */

  function setError(message) {
    errorEl.textContent = message || "";
    errorEl.classList.toggle("is-visible", !!message);
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

  function isOpen() {
    return dialog.classList.contains("is-open");
  }

  function openDialog(preselect) {
    setError("");
    Array.prototype.forEach.call(form.querySelectorAll('input[name="fn-split-ship-choice"]'), function (radio) {
      radio.checked = !!preselect && radio.value === preselect;
    });
    submitBtn.disabled = !preselect;
    submitBtn.textContent = submitLabel;
    dialog.hidden = false;
    dialog.classList.add("is-open");
    dialog.setAttribute("aria-hidden", "false");
    setInert(true);
    var target = form.querySelector('input[name="fn-split-ship-choice"]:checked') ||
      form.querySelector('input[name="fn-split-ship-choice"]');
    if (target) target.focus();
  }

  function closeDialog() {
    if (!isOpen() && dialog.hidden) return;
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

  /* Cart mutations */

  function cartSignature(cart) {
    var items = (cart.items || []).map(function (item) {
      return [item.variant_id || item.id, item.quantity];
    });
    return JSON.stringify({ items: items, preference: preferenceOf(cart) });
  }

  function setPreference(value) {
    var attrs = {};
    attrs[ATTR_KEY] = value || "";
    return request(routes.update, { attributes: attrs }).then(getCart);
  }

  function addFee(cart, force) {
    if (cart && classify(cart).feeItem) return Promise.resolve(cart);
    if (!force && Date.now() - state.lastFeeAddAt < 3000) return Promise.resolve(cart);
    state.lastFeeAddAt = Date.now();
    return request(routes.add, { items: [{ id: feeVariantId, quantity: 1 }] }).then(getCart);
  }

  function changeLine(item, quantity) {
    return request(routes.change, { id: item.key, quantity: quantity }).then(getCart);
  }

  function reconcile(cart) {
    var info = classify(cart);

    if (!info.mixed) {
      var tasks = Promise.resolve(cart);
      if (info.preference) {
        tasks = tasks.then(function () {
          return setPreference("");
        });
      }
      if (info.feeItem) {
        tasks = tasks.then(function (next) {
          var fee = classify(next).feeItem;
          return fee ? changeLine(fee, 0) : next;
        });
      }
      return tasks;
    }

    if (info.preference === VAL_SPLIT) {
      if (!info.feeItem) return addFee(cart, false);
      if (info.feeItem.quantity !== 1) return changeLine(info.feeItem, 1);
      return Promise.resolve(cart);
    }

    if (info.feeItem) return changeLine(info.feeItem, 0);
    return Promise.resolve(cart);
  }

  /* Theme refresh: Be Yours 8.1.1 has no cart:refresh listener, so re-render the drawer sections directly. */

  function refreshCartUI() {
    document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true, detail: { open: false } }));
    if (isCartPage()) {
      window.location.reload();
      return Promise.resolve();
    }
    return nativeFetch(root + "?sections=" + DRAWER_SECTIONS.join(","), { credentials: "same-origin" })
      .then(function (res) {
        return res.json();
      })
      .then(function (sections) {
        var parser = new DOMParser();
        DRAWER_SECTIONS.forEach(function (id) {
          var el = document.getElementById(id);
          if (!el || !sections || typeof sections[id] !== "string") return;
          var parsed = parser.parseFromString(sections[id], "text/html").querySelector(".shopify-section");
          if (parsed) el.innerHTML = parsed.innerHTML;
        });
      })
      .catch(function (err) {
        console.warn("[split-ship] drawer refresh failed", err);
      })
      .then(function () {
        if (state.cart) paint(state.cart);
      });
  }

  /* Cart UI */

  function hideWallets(hide) {
    document.body.classList.toggle("fn-split-ship-hide-wallets", hide);
    var ssr = document.getElementById("fn-split-ship-wallets-ssr");
    if (ssr) ssr.remove();
  }

  function lockFeeLine() {
    var selector = [
      "[data-fn-split-ship-fee]",
      'li[data-variant-id="' + feeVariantId + '"]',
    ].join(",");
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (row) {
      row.classList.add("fn-split-ship-fee-line");
      row.setAttribute("data-fn-split-ship-fee", "");
    });
    Array.prototype.forEach.call(
      document.querySelectorAll('input[data-quantity-variant-id="' + feeVariantId + '"]'),
      function (input) {
        var row = input.closest("tr, li");
        if (row) {
          row.classList.add("fn-split-ship-fee-line");
          row.setAttribute("data-fn-split-ship-fee", "");
        }
      }
    );
  }

  function statusSurfaces() {
    var surfaces = [];
    var drawerFooter = document.querySelector("#mini-cart .mini-cart__footer");
    if (drawerFooter) surfaces.push(drawerFooter);
    var cartFooter = document.querySelector("#main-cart-footer .cart__footer > div");
    if (cartFooter) surfaces.push(cartFooter);
    return surfaces;
  }

  function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  function fillStatus(node, copy) {
    setText(node.querySelector("[data-fn-split-ship-status-title]"), copy.title);
    setText(node.querySelector("[data-fn-split-ship-status-text]"), copy.text);
    if (node.hidden) node.hidden = false;
  }

  function updateStatus(info) {
    var visible = info.mixed && !!info.preference;
    var nodes = document.querySelectorAll("[data-fn-split-ship-status]");
    if (!visible) {
      Array.prototype.forEach.call(nodes, function (node) {
        node.hidden = true;
      });
      return;
    }
    var copy = COPY[choiceOf(info.preference)];
    Array.prototype.forEach.call(nodes, function (node) {
      fillStatus(node, copy);
    });
    if (!statusTemplate || !statusTemplate.content || !statusTemplate.content.firstElementChild) return;
    statusSurfaces().forEach(function (surface) {
      if (surface.querySelector("[data-fn-split-ship-status]")) return;
      var node = statusTemplate.content.firstElementChild.cloneNode(true);
      fillStatus(node, copy);
      surface.insertBefore(node, surface.firstChild);
    });
  }

  function paint(cart) {
    var info = classify(cart);
    lockFeeLine();
    hideWallets(info.mixed && !info.preference);
    updateStatus(info);
    if (info.mixed && !info.preference) {
      if (!isOpen() && !state.applying) openDialog("");
    } else if (!info.mixed && !state.applying) {
      closeDialog();
    }
  }

  function applyChoice(choice) {
    state.applying = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving\u2026";
    setError("");
    var preference = choice === "split" ? VAL_SPLIT : VAL_TOGETHER;
    return setPreference(preference)
      .then(function (cart) {
        var info = classify(cart);
        if (choice === "split") {
          if (!info.feeItem) return addFee(cart, true);
          if (info.feeItem.quantity !== 1) return changeLine(info.feeItem, 1);
          return cart;
        }
        return info.feeItem ? changeLine(info.feeItem, 0) : cart;
      })
      .then(function (cart) {
        state.cart = cart;
        state.applying = false;
        closeDialog();
        paint(cart);
        return refreshCartUI();
      })
      .catch(function (err) {
        state.applying = false;
        submitBtn.textContent = submitLabel;
        submitBtn.disabled = !selectedChoice();
        setError((err && err.message) || "Could not save that choice. Try again.");
      });
  }

  function sync() {
    if (state.applying) return;
    if (state.syncing) {
      scheduleSync();
      return;
    }
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
        if (result.changed) return refreshCartUI();
      })
      .catch(function (err) {
        console.warn("[split-ship]", err);
      })
      .then(function () {
        state.syncing = false;
      });
  }

  function scheduleSync(delay) {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(sync, delay || 250);
  }

  /* Events */

  form.addEventListener("change", function () {
    submitBtn.disabled = !selectedChoice() || state.applying;
    setError("");
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (state.applying) return;
    var choice = selectedChoice();
    if (!choice) {
      setError("Choose a shipping preference to continue.");
      return;
    }
    applyChoice(choice);
  });

  dialog.addEventListener("keydown", function (event) {
    if (!isOpen()) return;
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

  function needsChoice() {
    var info = classify(state.cart);
    return info.mixed && !info.preference;
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      var changeBtn = target.closest("[data-fn-split-ship-change]");
      if (changeBtn) {
        event.preventDefault();
        event.stopPropagation();
        openDialog(choiceOf(classify(state.cart).preference));
        return;
      }

      if (target.closest("[data-fn-split-ship-fee] quantity-input, [data-fn-split-ship-fee] cart-remove-button")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (!needsChoice()) return;
      var checkoutLike = target.closest(
        'button[name="checkout"], input[name="checkout"], a[href*="/checkout"], .cart__checkout-button'
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
      if (!formEl || formEl === form || !needsChoice()) return;
      var submitter = event.submitter;
      var isCheckout =
        (submitter && submitter.name === "checkout") ||
        (formEl.querySelector && formEl.querySelector('[name="checkout"]') && !submitter);
      if (!isCheckout) return;
      event.preventDefault();
      event.stopPropagation();
      openDialog("");
    },
    true
  );

  document.addEventListener("ajaxProduct:added", function () {
    scheduleSync();
  });
  document.addEventListener("cart:updated", function () {
    scheduleSync();
  });
  document.addEventListener("page:loaded", function () {
    scheduleSync();
  });

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var result = nativeFetch(input, init);
    if (isCartMutationUrl(url)) {
      result.then(
        function () {
          if (!state.applying) scheduleSync(400);
        },
        function () {}
      );
    }
    return result;
  };

  (function watchXhr() {
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (isCartMutationUrl(url)) {
        this.addEventListener("loadend", function () {
          if (!state.applying) scheduleSync(400);
        });
      }
      return open.apply(this, arguments);
    };
  })();

  var observerTimer = null;
  new MutationObserver(function () {
    if (!state.cart) return;
    clearTimeout(observerTimer);
    observerTimer = setTimeout(function () {
      lockFeeLine();
      updateStatus(classify(state.cart));
    }, 80);
  }).observe(document.body, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      scheduleSync(0);
    });
  } else {
    scheduleSync(0);
  }
})();
