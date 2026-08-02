/* ============================================================
   YouForge Hub — admin.js (SECTION 23n — extracted, added)

   This is the ENTIRE YF.admin module, split out of index.html into
   its own file purely for performance: it's ~6,300 lines of code
   that only an admin/support/product_manager session ever needs.
   Previously every visitor's browser had to download AND parse all
   of this even though ~99% of them never touch the admin panel.

   Loaded dynamically (see injectAdminMarkup() in index.html) ONLY
   once a session is confirmed to have admin-level access — a normal
   customer's browser never requests this file at all.

   Runs as a plain (non-module) global script, same as the main
   inline script it was extracted from: it depends on `YF` already
   existing as `window.YF` (set up earlier in index.html) and on
   `window.YF.firebase.*` for all Firestore access — it does not
   import anything of its own. This is why extracting it here is
   safe: every dependency crosses through window.YF, not raw closure
   variables from the original inline script.
   ============================================================ */
  YF.admin = (function(){

    let productsCache = [];
    let productsUnsub = null;
    const filters = { status: "all", category: "all", search: "" };

    // ---- Category Management state ----
    let categoriesCache = [];
    let categoriesUnsub = null;

    // ---- Bundles Manager state (SECTION 23f — added) ----
    let bundlesCache = [];
    let bundlesUnsub = null;
    let bundleSearch = "";

    // ---- Payment Methods Manager state ----
    let paymentMethodsCache = [];
    let paymentMethodsUnsub = null;
    let paymentMethodSearch = "";

    // ---- Social Settings Manager state ----
    let socialLinksCache = [];
    let socialLinksUnsub = null;
    let socialLinkSearch = "";

    // ---- Site Settings state ----
    let siteSettingsBound = false;

    // ---- Payment Approval Queue state ----
    let ordersCache = [];
    let ordersUnsub = null;
    const orderFilters = { status: "pending", search: "" };

    // ---- Withdrawal Requests state (Phase B) ----
    let withdrawalsCache = [];
    let withdrawalsUnsub = null;
    const withdrawalFilters = { status: "pending", search: "" };

    // ---- User Management state ----
    let usersCache = [];
    let usersUnsub = null;
    const userFilters = { role: "all", status: "all", search: "" };

    // ---- File upload state (Product Form) ----
    // Keyed by field ("image" | "file") so image + product-file uploads
    // can run independently without clobbering each other's progress UI.
    const uploads = { image: { url: "", uploading: false }, file: { url: "", uploading: false }, logo: { url: "", uploading: false }, favicon: { url: "", uploading: false }, pmQr: { url: "", uploading: false } };

    // ---- Coupons Manager state ----
    let couponsCache = [];
    let couponsUnsub = null;
    let couponSearch = "";
    let couponStatusFilter = "all";

    // ---- Announcements Manager state ----
    let announcementsCache = [];
    let announcementsUnsub = null;
    let announcementSearch = "";
    let announcementTypeFilter = "all";

    // ---- Notification Templates state ----
    let notifyTemplatesBound = false;

    // ---- Activity Logs state ----
    let activityLogsCache = [];
    let activityLogsUnsub = null;
    let activityLogSearch = "";
    let activityLogActionFilter = "all";

    function isAdmin(){
      return !!(window.YF.auth && window.YF.auth.currentUser && window.YF.auth.currentRole === "admin");
    }

    /** SECTION 23g — added. True if the current user (real admin OR a
     *  permitted sub-role) may manage this specific admin-* route —
     *  used ONLY for the handful of pages opened to "support"/
     *  "product_manager" (Products, Categories, Bundles, Tickets,
     *  Chat). Every other admin function in this module keeps using
     *  the strict isAdmin() above unchanged, so sub-roles never gain
     *  access to anything beyond their assigned area. */
    function canManage(route){
      return !!(window.YF.auth && window.YF.auth.currentUser && window.YF.roles && window.YF.roles.canAccessAdminRoute(route));
    }

    /** SECTION 23g — added. True for a real admin OR either limited
     *  sub-role — used only for shared, non-sensitive plumbing like
     *  file uploads (the Cloudinary URL alone can't write anything;
     *  the actual Firestore write that follows is gated by canManage
     *  above per-route). */
    function hasAnyAdminAccess(){
      return !!(window.YF.auth && window.YF.auth.currentUser && window.YF.roles && window.YF.roles.hasAnyAdminAccess());
    }

    function escapeHtml(str){
      return String(str)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function formatPrice(n){ return "$" + Number(n || 0).toFixed(2); }
    function formatMoney(n){ return "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

    /** Local copy of YF.ui's field-error helper — that one lives inside
     *  the YF.ui module closure and isn't reachable from here, so
     *  saveSocialLink() (and any other admin form validation) needs its
     *  own copy rather than calling the out-of-scope global by name. */
    function setFieldError(inputId, errorId, show){
      const input = document.getElementById(inputId);
      const error = document.getElementById(errorId);
      if (input) input.classList.toggle("is-invalid", !!show);
      if (error) error.classList.toggle("is-visible", !!show);
    }

    function categoryLabel(id){
      const cats = (window.YF.marketplace && window.YF.marketplace.CATEGORIES) || [];
      const c = cats.find(c => c.id === id);
      return c ? c.label : id;
    }

    /* ---------------------------------------------------------
       ACTIVITY LOGS — audit trail helper
       Called at the end of every admin-mutating action across this
       module, right after the underlying write succeeds. Never
       blocks or throws into the caller — a logging failure should
       never undo or interrupt the action that just happened, so any
       error here is only ever console.error'd. Every entry always
       carries the CURRENTLY signed-in admin's own uid (never a
       caller-supplied one), matching the "never trust client-supplied
       identity" rule used everywhere else in this file.
       --------------------------------------------------------- */
    async function logActivity(action, detail){
      const fb = window.YF.firebase;
      const user = window.YF.auth && window.YF.auth.currentUser;
      if (!(fb && fb.db && fb.addDoc && fb.collection) || !user) return;
      try{
        await fb.addDoc(fb.collection(fb.db, "activityLogs"), {
          adminUid: user.uid,
          adminEmail: user.email || "",
          adminName: (user.displayName || (user.email ? user.email.split("@")[0] : "Admin")),
          action: action || "unknown",
          detail: String(detail || "").slice(0, 300),
          createdAt: fb.serverTimestamp()
        });
      }catch(err){ console.error("YF.admin: logActivity failed", err); }
    }

    /* ---------------------------------------------------------
       PRODUCT MANAGEMENT
       --------------------------------------------------------- */

    function populateCategorySelects(){
      const cats = ((window.YF.marketplace && window.YF.marketplace.CATEGORIES) || []).filter(c => c.id !== "all");
      const filterSel = document.getElementById("adminProductCategoryFilter");
      const formSel = document.getElementById("productFormCategory");
      const catFormSel = document.getElementById("adminProductCategoryFilter"); // alias kept for clarity
      if (filterSel){
        const prevValue = filterSel.value;
        filterSel.innerHTML = `<option value="all">All categories</option>` +
          cats.map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
        // Keep the admin's current filter selection if that category
        // still exists; otherwise fall back to "all" rather than
        // silently landing on whatever the first <option> happens to be.
        if (cats.some(c => c.id === prevValue)) filterSel.value = prevValue;
      }
      if (formSel){
        const prevValue = formSel.value;
        formSel.innerHTML = cats.map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
        if (cats.some(c => c.id === prevValue)) formSel.value = prevValue;
      }
    }

    function subscribeProducts(){
      const fb = window.YF.firebase;
      if (productsUnsub){ try{ productsUnsub(); }catch(e){} productsUnsub = null; }
      if (!(fb && fb.db && fb.collection && fb.onSnapshot)){
        productsCache = [];
        renderProductsTable();
        return;
      }
      try{
        productsUnsub = fb.onSnapshot(fb.collection(fb.db, "products"), (snap) => {
          productsCache = snap.docs.map(d => {
            const data = d.data();
            return {
              id: d.id,
              title: data.title || "Untitled Product",
              description: data.description || "",
              gallery: Array.isArray(data.gallery) ? data.gallery : [],
              image: data.image || window.YF_NO_IMAGE,
              fileURL: data.fileURL || "",
              externalLink: data.externalLink || "",
              price: Number(data.price) || 0,
              oldPrice: data.oldPrice ? Number(data.oldPrice) : null,
              discountType: data.discountType || "none",
              discountValue: data.discountValue != null ? Number(data.discountValue) : null,
              discountStartsAt: data.discountStartsAt || null,
              discountEndsAt: data.discountEndsAt || null,
              seoTitle: data.seoTitle || "",
              seoDescription: data.seoDescription || "",
              seoKeywords: data.seoKeywords || "",
              category: data.category || "templates",
              sales: Number(data.sales) || 0,
              status: data.status || "published",
              featured: !!data.featured,
              stockLimit: data.stockLimit != null ? Number(data.stockLimit) : null,
              videoUrl: data.videoUrl || null,
              createdAt: (data.createdAt && data.createdAt.toMillis) ? data.createdAt.toMillis() : (data.createdAt || Date.now())
            };
          });
          renderProductsTable();
          // FIX: if the New/Edit Bundle modal happens to be open while
          // products are still loading, refresh its checklist too once
          // productsCache actually has data.
          const bundleModal = document.getElementById("bundleFormModal");
          if (bundleModal && bundleModal.classList.contains("is-open")){
            const editingId = document.getElementById("bundleFormId").value;
            const editingBundle = editingId ? bundlesCache.find(b => b.id === editingId) : null;
            renderBundleProductsChecklist(editingBundle ? editingBundle.productIds : []);
          }
        }, (err) => {
          console.error("YF.admin: products onSnapshot error", err);
          productsCache = [];
          renderProductsTable();
        });
      }catch(err){
        console.error("YF.admin: subscribeProducts failed", err);
        productsCache = [];
        renderProductsTable();
      }
    }

    function getFilteredProducts(){
      const q = filters.search.trim().toLowerCase();
      return productsCache.filter(p => {
        if (filters.status !== "all" && (p.status || "published") !== filters.status) return false;
        if (filters.category !== "all" && p.category !== filters.category) return false;
        if (q && !String(p.title || "").toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function statusBadge(status){
      const s = status || "published";
      const label = s.charAt(0).toUpperCase() + s.slice(1);
      return `<span class="status-badge status-badge--${s}">${label}</span>`;
    }

    function starIcon(filled){
      return filled
        ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15 9 22 9 16.5 13.5 18.5 21 12 16.5 5.5 21 7.5 13.5 2 9 9 9"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15 9 22 9 16.5 13.5 18.5 21 12 16.5 5.5 21 7.5 13.5 2 9 9 9"/></svg>`;
    }

    function renderProductsTable(){
      const tbody = document.getElementById("adminProductsTableBody");
      if (!tbody) return;
      const list = getFilteredProducts();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="7"><div class="admin-empty-state">No products match your filters.</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(p => `
        <tr data-product-row="${p.id}">
          <td>
            <div class="product-row__title-wrap">
              <img class="product-row__thumb" src="${escapeHtml(p.image || '')}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">
              <span class="product-row__title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>
            </div>
          </td>
          <td class="u-text-muted">${escapeHtml(categoryLabel(p.category))}</td>
          <td>${formatPrice(p.price)}</td>
          <td>
            <select class="form-input admin-status-select" data-status-select="${p.id}" aria-label="Change status">
              <option value="published" ${p.status === "published" ? "selected" : ""}>Published</option>
              <option value="draft" ${p.status === "draft" ? "selected" : ""}>Draft</option>
              <option value="archived" ${p.status === "archived" ? "selected" : ""}>Archived</option>
              <option value="hidden" ${p.status === "hidden" ? "selected" : ""}>Hidden</option>
            </select>
          </td>
          <td>
            <button type="button" class="featured-star-btn ${p.featured ? "is-featured" : ""}" data-toggle-featured="${p.id}" aria-label="Toggle featured" title="${p.featured ? "Featured" : "Not featured"}">
              ${starIcon(p.featured)}
            </button>
          </td>
          <td class="u-text-muted">${Number(p.sales || 0).toLocaleString()}</td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-product="${p.id}">Edit</button>
              <button type="button" class="admin-action-btn" data-manage-versions="${p.id}">Versions</button>
              <button type="button" class="admin-action-btn" data-duplicate-product="${p.id}">Duplicate</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-product="${p.id}">Delete</button>
            </div>
          </td>
        </tr>
      `).join("");
    }

    function openProductForm(mode, productId){
      populateCategorySelects();
      const form = document.getElementById("productForm");
      const title = document.getElementById("productFormModalTitle");
      form.reset();
      document.getElementById("productFormId").value = "";
      document.getElementById("productFormFeatured").checked = false;
      resetUploadUI("image");
      resetUploadUI("file");

      if (mode === "edit" || mode === "duplicate"){
        const p = productsCache.find(x => x.id === productId);
        if (!p) return;
        document.getElementById("productFormId").value = mode === "edit" ? p.id : "";
        document.getElementById("productFormTitle").value = mode === "duplicate" ? (p.title + " (Copy)") : p.title;
        document.getElementById("productFormDescription").value = p.description || "";
        document.getElementById("productFormCategory").value = p.category;
        document.getElementById("productFormStatus").value = mode === "duplicate" ? "draft" : (p.status || "published");
        document.getElementById("productFormPrice").value = p.price;
        document.getElementById("productFormOldPrice").value = p.oldPrice || "";
        document.getElementById("productFormDiscountType").value = p.discountType || "none";
        document.getElementById("productFormDiscountValue").value = p.discountValue != null ? p.discountValue : "";
        document.getElementById("productFormDiscountStart").value = tsToLocalInput(p.discountStartsAt);
        document.getElementById("productFormDiscountEnd").value = tsToLocalInput(p.discountEndsAt);
        document.getElementById("productFormSeoTitle").value = p.seoTitle || "";
        document.getElementById("productFormSeoDescription").value = p.seoDescription || "";
        document.getElementById("productFormSeoKeywords").value = p.seoKeywords || "";
        document.getElementById("productFormImage").value = p.image || "";
        document.getElementById("productFormGalleryData").value = JSON.stringify(Array.isArray(p.gallery) ? p.gallery : []);
        renderGalleryList();
        document.getElementById("productFormFileURL").value = p.fileURL || "";
        document.getElementById("productFormExternalLink").value = p.externalLink || "";
        document.getElementById("productFormFeatured").checked = mode === "duplicate" ? false : !!p.featured;
        document.getElementById("productFormStockLimit").value = (p.stockLimit != null) ? p.stockLimit : "";
        document.getElementById("productFormVideoUrl").value = p.videoUrl || "";
        title.textContent = mode === "edit" ? "Edit Product" : "Duplicate Product";
      } else {
        document.getElementById("productFormDiscountType").value = "none";
        document.getElementById("productFormDiscountValue").value = "";
        document.getElementById("productFormDiscountStart").value = "";
        document.getElementById("productFormDiscountEnd").value = "";
        document.getElementById("productFormSeoTitle").value = "";
        document.getElementById("productFormSeoDescription").value = "";
        document.getElementById("productFormSeoKeywords").value = "";
        document.getElementById("productFormStatus").value = "draft";
        document.getElementById("productFormDescription").value = "";
        document.getElementById("productFormGalleryData").value = "[]";
        renderGalleryList();
        title.textContent = "New Product";
      }
      window.YF.ui.openModal("productFormModal");
    }

    /** Convert a Firestore Timestamp (or millis/Date) into the string
     *  format <input type="datetime-local"> expects. Returns "" for
     *  null/undefined so the field just renders empty. */
    function tsToLocalInput(ts){
      if (!ts) return "";
      const ms = (ts && ts.toMillis) ? ts.toMillis() : (ts instanceof Date ? ts.getTime() : Number(ts));
      if (!ms || Number.isNaN(ms)) return "";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    async function saveProduct(e){
      e.preventDefault();
      if (!canManage('admin-products')){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const btn = document.getElementById("productFormSubmitBtn");
      const id = document.getElementById("productFormId").value;
      const discountType = document.getElementById("productFormDiscountType").value || "none";
      const discountStartRaw = document.getElementById("productFormDiscountStart").value;
      const discountEndRaw = document.getElementById("productFormDiscountEnd").value;
      const payload = {
        title: document.getElementById("productFormTitle").value.trim(),
        description: document.getElementById("productFormDescription").value.trim(),
        category: document.getElementById("productFormCategory").value,
        status: document.getElementById("productFormStatus").value,
        price: Number(document.getElementById("productFormPrice").value) || 0,
        oldPrice: document.getElementById("productFormOldPrice").value ? Number(document.getElementById("productFormOldPrice").value) : null,
        discountType: discountType,
        discountValue: discountType !== "none" ? (Number(document.getElementById("productFormDiscountValue").value) || 0) : null,
        discountStartsAt: discountType !== "none" && discountStartRaw ? new Date(discountStartRaw) : null,
        discountEndsAt: discountType !== "none" && discountEndRaw ? new Date(discountEndRaw) : null,
        seoTitle: document.getElementById("productFormSeoTitle").value.trim() || null,
        seoDescription: document.getElementById("productFormSeoDescription").value.trim() || null,
        seoKeywords: document.getElementById("productFormSeoKeywords").value.trim() || null,
        image: document.getElementById("productFormImage").value.trim(),
        gallery: getGalleryUrls(),
        fileURL: document.getElementById("productFormFileURL").value.trim(),
        externalLink: document.getElementById("productFormExternalLink").value.trim(),
        featured: document.getElementById("productFormFeatured").checked,
        videoUrl: document.getElementById("productFormVideoUrl").value.trim() || null,
        stockLimit: document.getElementById("productFormStockLimit").value !== "" ? Math.max(0, Number(document.getElementById("productFormStockLimit").value) || 0) : null
      };
      if (!payload.title){
        window.YF.ui.toast({ type:"danger", title:"Title required", message:"Please give the product a title." });
        return;
      }
      if (payload.externalLink && !/^https?:\/\//i.test(payload.externalLink)){
        window.YF.ui.toast({ type:"danger", title:"Invalid link", message:"External Link must start with http:// or https://." });
        return;
      }
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        if (!(fb && fb.db)){
          throw new Error("Firestore isn't available in this environment.");
        }
        if (id){
          await fb.updateDoc(fb.doc(fb.db, "products", id), { ...payload, updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Product updated", message:`"${payload.title}" was saved.` });
          logActivity("product-update", `Updated product "${payload.title}"`);
        } else {
          await fb.addDoc(fb.collection(fb.db, "products"), {
            ...payload,
            rating: 0, ratingCount: 0, sales: 0,
            createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
          });
          window.YF.ui.toast({ type:"success", title:"Product created", message:`"${payload.title}" was added.` });
          logActivity("product-create", `Created product "${payload.title}"`);
        }
        window.YF.ui.closeModal("productFormModal");
      }catch(err){
        console.error("YF.admin: saveProduct failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save product", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Product";
      }
    }

    async function duplicateProduct(productId){
      openProductForm("duplicate", productId);
    }

    /* ---------------------------------------------------------
       FILE VERSION MANAGEMENT + PRODUCT UPDATE NOTIFICATIONS (Phase F)
       Versions live in the product's own releaseNotes[] array —
       { version, notes, date, fileURL } — so the storefront's
       existing "Release Notes" tab and Version History downloads
       (see YF.marketplace.renderProductDownloadArea) both work off
       the SAME field with zero schema migration. Adding a version
       also bumps the product's top-level version/fileURL, so the
       main "Download File" button always serves the newest file.
       --------------------------------------------------------- */
    let versionsBound = false;

    function renderProductVersionsList(product){
      const el = document.getElementById("productVersionsList");
      if (!el) return;
      const notes = (product.releaseNotes && product.releaseNotes.length) ? [...product.releaseNotes].reverse() : [];
      el.innerHTML = notes.length
        ? notes.map(r => `
            <div class="payment-details__row u-mb-4">
              <div><div class="payment-details__row-label">v${escapeHtml(String(r.version))}</div><div class="u-text-muted" style="font-size:var(--fs-xs);">${escapeHtml(r.notes || "")}</div></div>
              <div class="u-text-muted" style="font-size:var(--fs-xs);">${r.date ? new Date(r.date).toLocaleDateString() : ""}</div>
            </div>`).join("")
        : `<p class="u-text-muted">No versions recorded yet — the product's current file counts as v${escapeHtml(product.version || "1.0.0")} until you add a new one.</p>`;
    }

    function openProductVersionsModal(productId){
      const product = productsCache.find(x => x.id === productId);
      if (!product) return;
      document.getElementById("productVersionsProductId").value = productId;
      document.getElementById("productVersionsModalTitle").textContent = `File Versions — ${product.title}`;
      renderProductVersionsList(product);
      document.getElementById("addProductVersionForm").reset();
      document.getElementById("newVersionNotifyTypeGroup").style.display = "none";
      bindProductVersionsModal();
      window.YF.ui.openModal("productVersionsModal");
    }

    /** Queries every license for this product and notifies each
     *  UNIQUE buyer once (a buyer with two licenses for the same
     *  product — e.g. a re-purchase after expiry — only gets pinged
     *  once), skipping revoked licenses since that buyer no longer
     *  has access to notify about. */
    async function notifyProductBuyers(productId, productTitle, notifyType){
      const fb = window.YF.firebase;
      const labels = {
        "new-version": { title: "New version available", verb: "A new version" },
        "security-update": { title: "Security update available", verb: "A security update" },
        "major-update": { title: "Major update available", verb: "A major update" }
      };
      const meta = labels[notifyType] || labels["new-version"];
      const snap = await fb.getDocs(fb.query(fb.collection(fb.db, "licenses"), fb.where("productId", "==", productId)));
      const uids = new Set();
      snap.docs.forEach(d => {
        const l = d.data();
        if (l.status !== "revoked" && l.userId) uids.add(l.userId);
      });
      let count = 0;
      for (const uid of uids){
        if (window.YF.notifications){
          await window.YF.notifications.create({
            uid, type: "info", title: meta.title,
            message: `${meta.verb} is available for "${productTitle}". Redownload from My Licenses to get it.`
          });
          count++;
        }
      }
      return count;
    }

    function bindProductVersionsModal(){
      if (versionsBound) return;
      versionsBound = true;
      document.getElementById("newVersionNotifyBuyers").addEventListener("change", (e) => {
        document.getElementById("newVersionNotifyTypeGroup").style.display = e.target.checked ? "" : "none";
      });
      document.getElementById("addProductVersionForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fb = window.YF.firebase;
        const productId = document.getElementById("productVersionsProductId").value;
        const product = productsCache.find(x => x.id === productId);
        if (!product) return;
        const version = document.getElementById("newVersionNumber").value.trim();
        const fileURL = document.getElementById("newVersionFileURL").value.trim();
        const notes = document.getElementById("newVersionNotes").value.trim();
        const shouldNotify = document.getElementById("newVersionNotifyBuyers").checked;
        const notifyType = document.getElementById("newVersionNotifyType").value;
        if (!version || !fileURL) return;

        const btn = document.getElementById("addProductVersionSubmitBtn");
        btn.disabled = true; btn.textContent = "Saving…";
        try{
          const entry = { version, notes, fileURL, date: Date.now() };
          await fb.updateDoc(fb.doc(fb.db, "products", productId), {
            releaseNotes: fb.arrayUnion ? fb.arrayUnion(entry) : [...(product.releaseNotes || []), entry],
            version, fileURL
          });
          logActivity("product_version_add", `Added v${version} to "${product.title}"`);
          let notifiedCount = 0;
          if (shouldNotify){
            notifiedCount = await notifyProductBuyers(productId, product.title, notifyType);
          }
          window.YF.ui.toast({ type:"success", title:"Version added", message: shouldNotify ? `Notified ${notifiedCount} buyer${notifiedCount === 1 ? "" : "s"}.` : "Saved." });
          window.YF.ui.closeModal("productVersionsModal");
        }catch(err){
          window.YF.ui.toast({ type:"danger", title:"Couldn't add version", message: err.message || "Please try again." });
        }finally{
          btn.disabled = false; btn.textContent = "Add Version";
        }
      });
    }

    function confirmDeleteProduct(productId){
      const p = productsCache.find(x => x.id === productId);
      if (!p) return;
      document.getElementById("deleteProductId").value = productId;
      document.getElementById("deleteProductTitle").textContent = p.title;
      window.YF.ui.openModal("deleteProductModal");
    }

    async function performDeleteProduct(){
      if (!canManage('admin-products')) return;
      const fb = window.YF.firebase;
      const id = document.getElementById("deleteProductId").value;
      if (!id) return;
      const btn = document.getElementById("confirmDeleteProductBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        const delProd = productsCache.find(x => x.id === id);
        await fb.deleteDoc(fb.doc(fb.db, "products", id));
        window.YF.ui.toast({ type:"info", title:"Product deleted", message:"The product was permanently removed." });
        logActivity("product-delete", `Deleted product "${(delProd && delProd.title) || id}"`);
        window.YF.ui.closeModal("deleteProductModal");
      }catch(err){
        console.error("YF.admin: deleteProduct failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete product", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    async function setProductStatus(productId, status){
      if (!canManage('admin-products')) return;
      const fb = window.YF.firebase;
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        await fb.updateDoc(fb.doc(fb.db, "products", productId), { status, updatedAt: fb.serverTimestamp() });
        window.YF.ui.toast({ type:"success", title:"Status updated", message:`Product marked as ${status}.` });
        logActivity("product-status", `Set product ${productId} status to ${status}`);
      }catch(err){
        console.error("YF.admin: setProductStatus failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't update status", message: err.message || "Please try again." });
        renderProductsTable(); // revert the <select> to the last known-good value
      }
    }

    async function toggleFeatured(productId){
      if (!canManage('admin-products')) return;
      const fb = window.YF.firebase;
      const p = productsCache.find(x => x.id === productId);
      if (!p) return;
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        await fb.updateDoc(fb.doc(fb.db, "products", productId), { featured: !p.featured, updatedAt: fb.serverTimestamp() });
        logActivity("product-featured", `${!p.featured ? "Featured" : "Unfeatured"} product "${p.title}"`);
      }catch(err){
        console.error("YF.admin: toggleFeatured failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't update product", message: err.message || "Please try again." });
      }
    }

    /* ---------------------------------------------------------
       FILE UPLOADS (Product Form) — images, ZIP, APK, PDF, EXE, etc.
       Files upload straight to Firebase Storage; only the resulting
       download URL is ever written to the "products" Firestore
       document (never the binary itself), matching the pattern
       already used by YF.orders.uploadPaymentScreenshot().
       --------------------------------------------------------- */

    function humanFileSize(bytes){
      if (!bytes && bytes !== 0) return "";
      const units = ["B", "KB", "MB", "GB"];
      let n = bytes, i = 0;
      while (n >= 1024 && i < units.length - 1){ n /= 1024; i++; }
      return `${n.toFixed(i > 0 && n < 10 ? 1 : 0)} ${units[i]}`;
    }

    const UPLOAD_FIELD_MAP = {
      image:   { zone: "productFormImageUploadZone",  progress: "productFormImageProgress",  bar: "productFormImageProgressBar",  name: "productFormImageFileName",  url: "productFormImage",     input: "productFormImageFile",  folder: "product-images" },
      file:    { zone: "productFormFileUploadZone",   progress: "productFormFileProgress",   bar: "productFormFileProgressBar",   name: "productFormFileFileName",   url: "productFormFileURL",   input: "productFormFileInput",  folder: "product-files" },
      logo:    { zone: "siteFormLogoUploadZone",       progress: "siteFormLogoProgress",       bar: "siteFormLogoProgressBar",       name: "siteFormLogoFileName",       url: "siteFormLogoUrl",       input: "siteFormLogoFile",       folder: "site-branding" },
      favicon: { zone: "siteFormFaviconUploadZone",    progress: "siteFormFaviconProgress",    bar: "siteFormFaviconProgressBar",    name: "siteFormFaviconFileName",    url: "siteFormFaviconUrl",    input: "siteFormFaviconFile",    folder: "site-branding" },
      pmQr:    { zone: "pmFormQrUploadZone",           progress: "pmFormQrProgress",           bar: "pmFormQrProgressBar",           name: "pmFormQrFileName",           url: "pmFormQrUrl",           input: "pmFormQrFile",           folder: "payment-qr-codes" },
      brokerLogo: { zone: "brokerFormLogoUploadZone",  progress: "brokerFormLogoProgress",      bar: "brokerFormLogoProgressBar",     name: "brokerFormLogoFileName",     url: "brokerFormLogoUrl",     input: "brokerFormLogoFile",     folder: "broker-logos" }
    };

    function uploadFieldIds(field){
      return UPLOAD_FIELD_MAP[field] || UPLOAD_FIELD_MAP.image;
    }

    function setUploadProgressUI(field, pct){
      const ids = uploadFieldIds(field);
      const wrap = document.getElementById(ids.progress);
      const bar = document.getElementById(ids.bar);
      if (wrap) wrap.classList.toggle("u-hidden", pct === null);
      if (bar) bar.style.width = (pct || 0) + "%";
    }

    function setUploadDoneUI(field, filename, size, url){
      const ids = uploadFieldIds(field);
      const nameEl = document.getElementById(ids.name);
      const zone = document.getElementById(ids.zone);
      if (nameEl) nameEl.textContent = url ? `${filename} (${humanFileSize(size)})` : "";
      if (zone) zone.classList.toggle("has-file", !!url);
    }

    function resetUploadUI(field){
      uploads[field] = { url: "", uploading: false };
      setUploadProgressUI(field, null);
      setUploadDoneUI(field, "", 0, "");
      const ids = uploadFieldIds(field);
      const fileInput = document.getElementById(ids.input);
      if (fileInput) fileInput.value = "";
    }

    /** Upload a single file (product image/file, site logo/favicon, or a
     *  payment method QR code) to Firebase Storage with a live progress
     *  bar, then writes the resulting download URL straight into the
     *  matching URL <input> so the owning save function picks it up
     *  exactly like a pasted URL would. */
      // Per-field client-side validation (a convenience layer only —
      // the Firebase Storage rules for each folder are the real
      // enforcement boundary, since this admin panel is client-side
      // JS and its "isAdmin()" check can't be trusted server-side).
      const FIELD_UPLOAD_LIMITS = {
        image:   { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * 1024 * 1024 },
        file:    { types: null /* any file type: zips, apks, exes, images */, maxBytes: 200 * 1024 * 1024 },
        logo:    { types: ["image/jpeg", "image/png", "image/webp", "image/svg+xml"], maxBytes: 2 * 1024 * 1024 },
        favicon: { types: ["image/jpeg", "image/png", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"], maxBytes: 1 * 1024 * 1024 },
        pmQr:    { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 2 * 1024 * 1024 },
        brokerLogo: { types: ["image/jpeg", "image/png", "image/webp", "image/svg+xml"], maxBytes: 2 * 1024 * 1024 }
      };

    async function handleFileUpload(field, file){
      if (!file) return;
      if (!hasAnyAdminAccess()){
        window.YF.ui.toast({ type:"danger", title:"Not authorized", message:"Only admins can upload files here." });
        return;
      }
      const limits = FIELD_UPLOAD_LIMITS[field] || FIELD_UPLOAD_LIMITS.image;
      if (limits.types && !limits.types.includes(file.type)){
        window.YF.ui.toast({ type:"danger", title:"Unsupported file type", message:"Please choose a supported file format." });
        return;
      }
      if (file.size > limits.maxBytes){
        window.YF.ui.toast({ type:"danger", title:"File too large", message:`File must be smaller than ${humanFileSize(limits.maxBytes)}.` });
        return;
      }
      if (!uploads[field]) uploads[field] = { url: "", uploading: false };
      uploads[field].uploading = true;
      setUploadProgressUI(field, 0);
      const folder = uploadFieldIds(field).folder || "uploads";
      try{
        const result = await window.YF.cloudinaryUpload(file, folder, (pct) => setUploadProgressUI(field, pct));
        const url = result.secure_url;
        uploads[field].url = url;
        setUploadProgressUI(field, null);
        setUploadDoneUI(field, file.name, file.size, url);
        const urlInput = document.getElementById(uploadFieldIds(field).url);
        if (urlInput) urlInput.value = url;
        // Broker logos also keep Cloudinary's public_id alongside the
        // URL (cloudinaryPublicId field on the broker doc) — needed if
        // the logo is ever replaced/removed later.
        if (field === "brokerLogo"){
          const publicIdInput = document.getElementById("brokerFormLogoPublicId");
          if (publicIdInput) publicIdInput.value = result.public_id || "";
        }
        window.YF.ui.toast({ type:"success", title:"Upload complete", message:`${file.name} uploaded successfully.` });
      }catch(err){
        console.error("YF.admin: file upload failed", err);
        setUploadProgressUI(field, null);
        window.YF.ui.toast({ type:"danger", title:"Upload failed", message: err.message || "Please try again." });
      }finally{
        uploads[field].uploading = false;
      }
    }

    /* ---------------------------------------------------------
       SECTION 22: PRODUCT GALLERY MANAGER (multi-image support)
       The hidden #productFormGalleryData input is the single source
       of truth (a JSON array of Cloudinary URLs) — it survives modal
       re-renders and is read directly by saveProduct(). The visible
       thumbnail grid (#productFormGalleryList) is re-rendered from
       it after every add/remove.
       --------------------------------------------------------- */
    function getGalleryUrls(){
      try{
        const el = document.getElementById("productFormGalleryData");
        const a = JSON.parse((el && el.value) || "[]");
        return Array.isArray(a) ? a.filter(u => typeof u === "string" && u) : [];
      }catch(_){ return []; }
    }

    function setGalleryUrls(urls){
      const el = document.getElementById("productFormGalleryData");
      if (el) el.value = JSON.stringify(urls);
      renderGalleryList();
    }

    function renderGalleryList(){
      const list = document.getElementById("productFormGalleryList");
      if (!list) return;
      const urls = getGalleryUrls();
      list.innerHTML = urls.map((u, i) => `
        <div class="yf-gallery-item">
          <img src="${escapeHtml(u)}" alt="Gallery image ${i + 1}" loading="lazy">
          <button type="button" class="yf-gallery-item__remove" data-gallery-remove="${i}" aria-label="Remove gallery image" title="Remove">×</button>
        </div>`).join("");
      list.querySelectorAll("[data-gallery-remove]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          const next = getGalleryUrls();
          next.splice(Number(btn.dataset.galleryRemove), 1);
          setGalleryUrls(next);
        });
      });
    }

    /** Uploads every file the admin selected, sequentially (so the
     *  single progress bar always reflects the file in flight), and
     *  appends each Cloudinary URL to the gallery list as it lands —
     *  a failure on one file never blocks the rest. */
    async function handleGalleryUpload(fileList){
      const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith("image/"));
      if (!files.length) return;
      const nameEl = document.getElementById("productFormGalleryFileName");
      const wrap = document.getElementById("productFormGalleryProgress");
      const bar = document.getElementById("productFormGalleryProgressBar");
      if (wrap) wrap.classList.remove("u-hidden");
      let added = 0;
      for (let i = 0; i < files.length; i++){
        const f = files[i];
        if (nameEl) nameEl.textContent = `Uploading ${i + 1} of ${files.length} — ${f.name}`;
        if (bar) bar.style.width = "0%";
        try{
          const result = await window.YF.cloudinaryUpload(f, "product-images", (pct) => { if (bar) bar.style.width = pct + "%"; });
          const url = result && (result.secure_url || result.url);
          if (!url) throw new Error("Upload response had no URL.");
          const next = getGalleryUrls();
          next.push(url);
          setGalleryUrls(next);
          added++;
        }catch(err){
          console.error("YF.admin: gallery upload failed", err);
          window.YF.ui.toast({ type:"danger", title:"Upload failed", message:`${f.name}: ${err.message || "please try again."}` });
        }
      }
      if (wrap) wrap.classList.add("u-hidden");
      if (bar) bar.style.width = "0%";
      if (nameEl) nameEl.textContent = added ? `${added} image${added === 1 ? "" : "s"} added` : "";
    }

    function bindFileUploadInputs(){
      const imgInput = document.getElementById("productFormImageFile");
      if (imgInput && imgInput.dataset.bound !== "true"){
        imgInput.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) handleFileUpload("image", f); });
        imgInput.dataset.bound = "true";
      }
      // SECTION 22: multi-image gallery input — uploads every selected
      // file to Cloudinary one by one, appending each URL to the list.
      const galInput = document.getElementById("productFormGalleryFile");
      if (galInput && galInput.dataset.bound !== "true"){
        galInput.addEventListener("change", (e) => {
          handleGalleryUpload(e.target.files);
          e.target.value = ""; // allow re-selecting the same files later
        });
        galInput.dataset.bound = "true";
      }
      const fileInput = document.getElementById("productFormFileInput");
      if (fileInput && fileInput.dataset.bound !== "true"){
        fileInput.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) handleFileUpload("file", f); });
        fileInput.dataset.bound = "true";
      }
      const imgRemoveBtn = document.getElementById("productFormImageRemoveBtn");
      if (imgRemoveBtn && imgRemoveBtn.dataset.bound !== "true"){
        imgRemoveBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); resetUploadUI("image"); document.getElementById("productFormImage").value = ""; });
        imgRemoveBtn.dataset.bound = "true";
      }
      const fileRemoveBtn = document.getElementById("productFormFileRemoveBtn");
      if (fileRemoveBtn && fileRemoveBtn.dataset.bound !== "true"){
        fileRemoveBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); resetUploadUI("file"); document.getElementById("productFormFileURL").value = ""; });
        fileRemoveBtn.dataset.bound = "true";
      }
    }

    /** Same wiring as bindFileUploadInputs() above, generalized for the
     *  Site Settings (logo/favicon) and Payment Method (QR) upload
     *  zones so they can each bind independently the first time their
     *  own page/modal opens. */
    function bindExtraUploadInputs(fieldsWithRemoveBtnIds){
      fieldsWithRemoveBtnIds.forEach(({ field, removeBtnId, urlInputId }) => {
        const ids = uploadFieldIds(field);
        const input = document.getElementById(ids.input);
        if (input && input.dataset.bound !== "true"){
          input.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) handleFileUpload(field, f); });
          input.dataset.bound = "true";
        }
        const removeBtn = document.getElementById(removeBtnId);
        if (removeBtn && removeBtn.dataset.bound !== "true"){
          removeBtn.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            resetUploadUI(field);
            const urlInput = document.getElementById(urlInputId);
            if (urlInput) urlInput.value = "";
          });
          removeBtn.dataset.bound = "true";
        }
      });
    }

    function bindProductsPage(){
      const tbody = document.getElementById("adminProductsTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-product]");
          const dupBtn = e.target.closest("[data-duplicate-product]");
          const delBtn = e.target.closest("[data-delete-product]");
          const starBtn = e.target.closest("[data-toggle-featured]");
          const versionsBtn = e.target.closest("[data-manage-versions]");
          if (editBtn) openProductForm("edit", editBtn.dataset.editProduct);
          if (dupBtn) duplicateProduct(dupBtn.dataset.duplicateProduct);
          if (delBtn) confirmDeleteProduct(delBtn.dataset.deleteProduct);
          if (starBtn) toggleFeatured(starBtn.dataset.toggleFeatured);
          if (versionsBtn) openProductVersionsModal(versionsBtn.dataset.manageVersions);
        });
        tbody.addEventListener("change", (e) => {
          const sel = e.target.closest("[data-status-select]");
          if (sel) setProductStatus(sel.dataset.statusSelect, sel.value);
        });
        tbody.dataset.bound = "true";
      }

      const newBtn = document.getElementById("adminNewProductBtn");
      if (newBtn && newBtn.dataset.bound !== "true"){
        newBtn.addEventListener("click", () => openProductForm("create"));
        newBtn.dataset.bound = "true";
      }

      const form = document.getElementById("productForm");
      if (form && form.dataset.bound !== "true"){
        form.addEventListener("submit", saveProduct);
        form.dataset.bound = "true";
      }

      const confirmDelBtn = document.getElementById("confirmDeleteProductBtn");
      if (confirmDelBtn && confirmDelBtn.dataset.bound !== "true"){
        confirmDelBtn.addEventListener("click", performDeleteProduct);
        confirmDelBtn.dataset.bound = "true";
      }

      const searchInput = document.getElementById("adminProductSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { filters.search = e.target.value; renderProductsTable(); });
        searchInput.dataset.bound = "true";
      }
      const statusFilter = document.getElementById("adminProductStatusFilter");
      if (statusFilter && statusFilter.dataset.bound !== "true"){
        statusFilter.addEventListener("change", (e) => { filters.status = e.target.value; renderProductsTable(); });
        statusFilter.dataset.bound = "true";
      }
      const categoryFilter = document.getElementById("adminProductCategoryFilter");
      if (categoryFilter && categoryFilter.dataset.bound !== "true"){
        categoryFilter.addEventListener("change", (e) => { filters.category = e.target.value; renderProductsTable(); });
        categoryFilter.dataset.bound = "true";
      }

      bindFileUploadInputs();

      // ---- CSV Export / Import (SECTION 23e — added) ----
      const exportBtn = document.getElementById("adminExportProductsCsvBtn");
      if (exportBtn && exportBtn.dataset.bound !== "true"){
        exportBtn.addEventListener("click", exportProductsCsv);
        exportBtn.dataset.bound = "true";
      }
      const importBtn = document.getElementById("adminImportProductsCsvBtn");
      const importInput = document.getElementById("adminImportProductsCsvInput");
      if (importBtn && importBtn.dataset.bound !== "true"){
        importBtn.addEventListener("click", () => importInput && importInput.click());
        importBtn.dataset.bound = "true";
      }
      if (importInput && importInput.dataset.bound !== "true"){
        importInput.addEventListener("change", (e) => {
          const file = e.target.files && e.target.files[0];
          if (file) importProductsCsv(file);
          importInput.value = "";
        });
        importInput.dataset.bound = "true";
      }
    }

    const PRODUCT_CSV_COLUMNS = ["id", "title", "description", "category", "status", "price", "oldPrice", "image", "fileURL", "externalLink", "featured"];

    /** Exports every product currently in productsCache to a CSV file
     *  the admin can edit in Excel/Sheets and re-import. Uses the same
     *  csvEscape()/downloadBlob() helpers as the Admin Reports export
     *  (SECTION 20m) — no new dependency. */
    function exportProductsCsv(){
      if (!productsCache.length){
        window.YF.ui.toast({ type:"info", title:"Nothing to export", message:"There are no products yet." });
        return;
      }
      const lines = [PRODUCT_CSV_COLUMNS.join(",")];
      productsCache.forEach(p => {
        lines.push(PRODUCT_CSV_COLUMNS.map(c => csvEscape(p[c] ?? "")).join(","));
      });
      downloadBlob(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" }), "products-export.csv");
    }

    /** Minimal RFC4180-ish CSV line parser (handles quoted fields with
     *  embedded commas/quotes) — no external dependency needed since
     *  PapaParse isn't loaded on this page (it's used elsewhere for
     *  browser-side spreadsheet import in the Excel skill, not here). */
    function parseCsv(text){
      const rows = [];
      let row = [], field = "", inQuotes = false;
      for (let i = 0; i < text.length; i++){
        const c = text[i], next = text[i + 1];
        if (inQuotes){
          if (c === '"' && next === '"'){ field += '"'; i++; }
          else if (c === '"'){ inQuotes = false; }
          else field += c;
        } else {
          if (c === '"') inQuotes = true;
          else if (c === ','){ row.push(field); field = ""; }
          else if (c === "\n" || c === "\r"){
            if (c === "\r" && next === "\n") i++;
            row.push(field); field = "";
            if (row.length > 1 || row[0] !== "") rows.push(row);
            row = [];
          } else field += c;
        }
      }
      if (field !== "" || row.length){ row.push(field); rows.push(row); }
      return rows;
    }

    /** Bulk import from a CSV built with the same column headers as
     *  exportProductsCsv(). A row with a matching existing "id" is
     *  updated in place; a row with no "id" (or one that doesn't match
     *  any current product) creates a new product. Never deletes any
     *  existing product — import is additive/updating only, so it can
     *  never accidentally wipe out the current catalog. */
    async function importProductsCsv(file){
      if (!canManage('admin-products')) return;
      const summaryEl = document.getElementById("adminImportProductsCsvSummary");
      const fb = window.YF.firebase;
      if (!(fb && fb.db)){
        window.YF.ui.toast({ type:"danger", title:"Import failed", message:"Firestore isn't available right now." });
        return;
      }
      let text;
      try{ text = await file.text(); }
      catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't read file", message: "Please choose a valid .csv file." }); return; }

      const rows = parseCsv(text);
      if (rows.length < 2){
        window.YF.ui.toast({ type:"info", title:"Nothing to import", message:"The CSV has no data rows." });
        return;
      }
      const header = rows[0].map(h => h.trim());
      let created = 0, updated = 0, failed = 0;
      for (let i = 1; i < rows.length; i++){
        const cols = rows[i];
        if (!cols.length || (cols.length === 1 && !cols[0])) continue; // skip blank lines
        const obj = {};
        header.forEach((h, idx) => { obj[h] = cols[idx] !== undefined ? cols[idx] : ""; });
        if (!obj.title || !String(obj.title).trim()) { failed++; continue; }
        const payload = {
          title: String(obj.title || "").trim(),
          description: String(obj.description || "").trim(),
          category: String(obj.category || "templates").trim(),
          status: ["published", "draft", "archived", "hidden"].includes(obj.status) ? obj.status : "draft",
          price: Number(obj.price) || 0,
          oldPrice: obj.oldPrice ? Number(obj.oldPrice) : null,
          image: String(obj.image || "").trim(),
          fileURL: String(obj.fileURL || "").trim(),
          externalLink: String(obj.externalLink || "").trim(),
          featured: String(obj.featured).toLowerCase() === "true"
        };
        try{
          const existing = obj.id && productsCache.find(p => p.id === obj.id);
          if (existing){
            await fb.updateDoc(fb.doc(fb.db, "products", existing.id), { ...payload, updatedAt: fb.serverTimestamp() });
            updated++;
          } else {
            await fb.addDoc(fb.collection(fb.db, "products"), {
              ...payload, rating: 0, ratingCount: 0, sales: 0,
              createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
            });
            created++;
          }
        }catch(err){
          console.error("YF.admin: CSV row import failed", err);
          failed++;
        }
      }
      logActivity("product-csv-import", `Imported CSV: ${created} created, ${updated} updated, ${failed} failed`);
      if (summaryEl){
        summaryEl.textContent = `Import finished — ${created} created, ${updated} updated${failed ? `, ${failed} failed` : ""}.`;
        summaryEl.classList.remove("u-hidden");
      }
      window.YF.ui.toast({
        type: failed ? "info" : "success",
        title: "CSV import finished",
        message: `${created} created, ${updated} updated${failed ? `, ${failed} row(s) failed` : ""}.`
      });
    }

    /** Entry point wired from handleRouteClick for data-route="admin-products".
     *  Independently re-verifies isAdmin() — never trusts that the link
     *  being clickable means the caller is actually an admin. */
    function renderProductsPage(){
      if (!canManage('admin-products')){
        window.YF.ui.navigateTo("home");
        return;
      }
      populateCategorySelects();
      bindProductsPage();
      if (!productsUnsub) subscribeProducts(); else renderProductsTable();
    }

    /* ---------------------------------------------------------
       CATEGORY MANAGEMENT
       Categories live in a top-level "categories" Firestore
       collection, keyed by a slug doc-id that IS the category id
       stored on every product.category field (never a random
       auto-id — this keeps the id stable and human-readable).
       While this collection is empty, Product Management and the
       public Marketplace keep using the built-in default category
       list below — nothing breaks before an admin adds any.
       Matching Firestore security rule:
         match /categories/{id} {
           allow read: if true;
           allow create, update, delete: if request.auth != null && isAdmin();
         }
       --------------------------------------------------------- */

    function slugify(label){
      return String(label || "")
        .toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "category";
    }

    /** Pushes the live "categories" collection into
     *  window.YF.marketplace.CATEGORIES BY REFERENCE (same array
     *  every module already reads from — the sidebar categories bar,
     *  the marketplace filter, the Product Form category <select>),
     *  so nothing elsewhere needs its own Firestore listener. Only
     *  runs once at least one real category exists, so a brand-new
     *  store with an empty "categories" collection still shows the
     *  default set instead of an empty list. */
    function syncMarketplaceCategories(){
      const mp = window.YF.marketplace;
      if (!mp || !Array.isArray(mp.CATEGORIES) || !categoriesCache.length) return;
      const allEntry = mp.CATEGORIES.find(c => c.id === "all") || { id: "all", label: "All Products" };
      const merged = [allEntry, ...categoriesCache.map(c => ({ id: c.id, label: c.label }))];
      mp.CATEGORIES.length = 0;
      merged.forEach(c => mp.CATEGORIES.push(c));
    }

    function productCountForCategory(categoryId){
      return productsCache.filter(p => p.category === categoryId).length;
    }

    function subscribeCategories(){
      const fb = window.YF.firebase;
      if (categoriesUnsub){ try{ categoriesUnsub(); }catch(e){} categoriesUnsub = null; }
      if (!(fb && fb.db && fb.collection && fb.onSnapshot)){
        categoriesCache = [];
        renderCategoriesTable();
        return;
      }
      try{
        categoriesUnsub = fb.onSnapshot(fb.collection(fb.db, "categories"), (snap) => {
          categoriesCache = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
          syncMarketplaceCategories();
          populateCategorySelects();
          renderCategoriesTable();
        }, (err) => {
          console.error("YF.admin: categories onSnapshot error", err);
          renderCategoriesTable();
        });
      }catch(err){
        console.error("YF.admin: subscribeCategories failed", err);
        renderCategoriesTable();
      }
    }

    let categorySearch = "";

    function renderCategoriesTable(){
      const tbody = document.getElementById("adminCategoriesTableBody");
      if (!tbody) return;
      const q = categorySearch.trim().toLowerCase();
      const list = categoriesCache.filter(c =>
        !q || String(c.label || "").toLowerCase().includes(q) || String(c.id).toLowerCase().includes(q)
      );
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="4"><div class="admin-empty-state">${
          categoriesCache.length
            ? "No categories match your search."
            : "No custom categories yet — the marketplace is using its built-in default set. Add one to get started."
        }</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(c => `
        <tr data-category-row="${c.id}">
          <td class="product-row__title">${escapeHtml(c.label || c.id)}</td>
          <td><span class="category-id-chip">${escapeHtml(c.id)}</span></td>
          <td><span class="category-count-chip">${productCountForCategory(c.id)}</span></td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-category="${c.id}">Edit</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-category="${c.id}">Delete</button>
            </div>
          </td>
        </tr>
      `).join("");
    }

    function openCategoryForm(mode, categoryId){
      const form = document.getElementById("categoryForm");
      const title = document.getElementById("categoryFormModalTitle");
      const idInput = document.getElementById("categoryFormId");
      form.reset();
      document.getElementById("categoryFormMode").value = mode;
      if (mode === "edit"){
        const c = categoriesCache.find(x => x.id === categoryId);
        if (!c) return;
        document.getElementById("categoryFormLabel").value = c.label || c.id;
        idInput.value = c.id;
        idInput.disabled = true;
        title.textContent = "Edit Category";
      } else {
        idInput.value = "";
        idInput.disabled = false;
        title.textContent = "New Category";
      }
      window.YF.ui.openModal("categoryFormModal");
    }

    async function saveCategory(e){
      e.preventDefault();
      if (!canManage('admin-categories')){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const mode = document.getElementById("categoryFormMode").value;
      const label = document.getElementById("categoryFormLabel").value.trim();
      let id = document.getElementById("categoryFormId").value.trim();
      if (!label){
        window.YF.ui.toast({ type:"danger", title:"Label required", message:"Please give the category a label." });
        return;
      }
      const btn = document.getElementById("categoryFormSubmitBtn");
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        if (mode === "edit"){
          await fb.updateDoc(fb.doc(fb.db, "categories", id), { label, updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Category updated", message:`"${label}" was saved.` });
          logActivity("category-update", `Renamed category "${id}" to "${label}"`);
        } else {
          id = slugify(id || label);
          if (id === "all") throw new Error(`"all" is a reserved category id — please choose another.`);
          if (categoriesCache.some(c => c.id === id)) throw new Error(`A category with id "${id}" already exists.`);
          await fb.setDoc(fb.doc(fb.db, "categories", id), { label, createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Category created", message:`"${label}" was added.` });
          logActivity("category-create", `Created category "${label}" (${id})`);
        }
        window.YF.ui.closeModal("categoryFormModal");
      }catch(err){
        console.error("YF.admin: saveCategory failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save category", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Category";
      }
    }

    function confirmDeleteCategory(categoryId){
      const c = categoriesCache.find(x => x.id === categoryId);
      if (!c) return;
      const count = productCountForCategory(categoryId);
      if (count > 0){
        window.YF.ui.toast({ type:"danger", title:"Category in use", message:`${count} product(s) still use "${c.label || c.id}". Reassign them first.` });
        return;
      }
      document.getElementById("deleteCategoryId").value = categoryId;
      document.getElementById("deleteCategoryLabel").textContent = c.label || c.id;
      window.YF.ui.openModal("deleteCategoryModal");
    }

    async function performDeleteCategory(){
      if (!canManage('admin-categories')) return;
      const fb = window.YF.firebase;
      const id = document.getElementById("deleteCategoryId").value;
      if (!id) return;
      const btn = document.getElementById("confirmDeleteCategoryBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        await fb.deleteDoc(fb.doc(fb.db, "categories", id));
        window.YF.ui.toast({ type:"info", title:"Category deleted", message:"The category was permanently removed." });
        logActivity("category-delete", `Deleted category "${id}"`);
        window.YF.ui.closeModal("deleteCategoryModal");
      }catch(err){
        console.error("YF.admin: deleteCategory failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete category", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    function bindCategoriesPage(){
      const tbody = document.getElementById("adminCategoriesTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-category]");
          const delBtn = e.target.closest("[data-delete-category]");
          if (editBtn) openCategoryForm("edit", editBtn.dataset.editCategory);
          if (delBtn) confirmDeleteCategory(delBtn.dataset.deleteCategory);
        });
        tbody.dataset.bound = "true";
      }
      const newBtn = document.getElementById("adminNewCategoryBtn");
      if (newBtn && newBtn.dataset.bound !== "true"){
        newBtn.addEventListener("click", () => openCategoryForm("create"));
        newBtn.dataset.bound = "true";
      }
      const form = document.getElementById("categoryForm");
      if (form && form.dataset.bound !== "true"){
        form.addEventListener("submit", saveCategory);
        form.dataset.bound = "true";
      }
      const confirmDelBtn = document.getElementById("confirmDeleteCategoryBtn");
      if (confirmDelBtn && confirmDelBtn.dataset.bound !== "true"){
        confirmDelBtn.addEventListener("click", performDeleteCategory);
        confirmDelBtn.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminCategorySearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { categorySearch = e.target.value; renderCategoriesTable(); });
        searchInput.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-categories". */
    function renderCategoriesPage(){
      if (!canManage('admin-categories')){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindCategoriesPage();
      if (!categoriesUnsub) subscribeCategories(); else renderCategoriesTable();
    }

    /* ---------------------------------------------------------
       SECTION 23f: BUNDLES MANAGEMENT (added)
       Full CRUD against a top-level "bundles" collection. Each
       bundle stores `productIds` — an array of existing product ids
       (never a copy of the products themselves), so editing a
       product's title/price/image later is automatically reflected
       wherever that product appears inside any bundle.
       --------------------------------------------------------- */

    function subscribeBundles(){
      if (bundlesUnsub){ try{ bundlesUnsub(); }catch(e){} bundlesUnsub = null; }
      const fb = window.YF.firebase;
      if (!(fb && fb.db && fb.onSnapshot)){ bundlesCache = []; renderBundlesTable(); return; }
      bundlesUnsub = fb.onSnapshot(fb.collection(fb.db, "bundles"), (snap) => {
        bundlesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderBundlesTable();
      }, (err) => { console.error("YF.admin: subscribeBundles failed", err); bundlesCache = []; renderBundlesTable(); });
    }

    function getFilteredBundles(){
      const q = bundleSearch.trim().toLowerCase();
      if (!q) return bundlesCache;
      return bundlesCache.filter(b => String(b.title || "").toLowerCase().includes(q));
    }

    function renderBundlesTable(){
      const tbody = document.getElementById("adminBundlesTableBody");
      if (!tbody) return;
      const list = getFilteredBundles();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="5"><div class="admin-empty-state">No bundles yet. Click "New Bundle" to create one.</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(b => {
        const count = Array.isArray(b.productIds) ? b.productIds.length : 0;
        return `
        <tr>
          <td>
            <div class="order-buyer__name">${escapeHtml(b.title || "Untitled bundle")}</div>
          </td>
          <td class="u-text-muted">${count} product${count === 1 ? "" : "s"}</td>
          <td class="order-amount">${formatPrice(b.price)}</td>
          <td><span class="status-badge ${b.status === "published" ? "status-badge--approved" : "status-badge--pending"}">${escapeHtml(b.status === "published" ? "Published" : "Draft")}</span></td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-bundle="${escapeHtml(b.id)}">Edit</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-bundle="${escapeHtml(b.id)}">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join("");
    }

    function renderBundleProductsChecklist(selectedIds){
      const el = document.getElementById("bundleFormProductsList");
      if (!el) return;
      if (!productsCache.length){
        el.innerHTML = `<p class="u-text-muted" style="font-size:var(--fs-sm);">No products available yet — create a product first.</p>`;
        return;
      }
      const selected = new Set(selectedIds || []);
      el.innerHTML = productsCache.map(p => `
        <label class="filter-check">
          <input type="checkbox" value="${escapeHtml(p.id)}" ${selected.has(p.id) ? "checked" : ""}>
          ${escapeHtml(p.title)} <span class="u-text-muted">(${formatPrice(p.price)})</span>
        </label>`).join("");
    }

    function openBundleForm(mode, bundleId){
      const bundle = mode === "edit" ? bundlesCache.find(b => b.id === bundleId) : null;
      document.getElementById("bundleFormModalTitle").textContent = mode === "edit" ? "Edit Bundle" : "New Bundle";
      document.getElementById("bundleFormId").value = bundle ? bundle.id : "";
      document.getElementById("bundleFormTitle").value = bundle ? (bundle.title || "") : "";
      document.getElementById("bundleFormDescription").value = bundle ? (bundle.description || "") : "";
      document.getElementById("bundleFormImage").value = bundle ? (bundle.image || "") : "";
      document.getElementById("bundleFormPrice").value = bundle ? (bundle.price != null ? bundle.price : "") : "";
      document.getElementById("bundleFormStatus").value = bundle ? (bundle.status || "published") : "published";
      renderBundleProductsChecklist(bundle ? bundle.productIds : []);
      window.YF.ui.openModal("bundleFormModal");
    }

    async function saveBundle(e){
      e.preventDefault();
      if (!canManage('admin-bundles')){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const btn = document.getElementById("bundleFormSubmitBtn");
      const id = document.getElementById("bundleFormId").value;
      const title = document.getElementById("bundleFormTitle").value.trim();
      const price = Number(document.getElementById("bundleFormPrice").value);
      const productIds = Array.from(document.querySelectorAll("#bundleFormProductsList input[type=checkbox]:checked")).map(cb => cb.value);
      if (!title){
        window.YF.ui.toast({ type:"danger", title:"Title required", message:"Please give the bundle a title." });
        return;
      }
      if (!Number.isFinite(price) || price < 0){
        window.YF.ui.toast({ type:"danger", title:"Invalid price", message:"Please enter a valid bundle price." });
        return;
      }
      if (!productIds.length){
        window.YF.ui.toast({ type:"danger", title:"No products selected", message:"Select at least one product to include in this bundle." });
        return;
      }
      const payload = {
        title,
        description: document.getElementById("bundleFormDescription").value.trim(),
        image: document.getElementById("bundleFormImage").value.trim(),
        price,
        status: document.getElementById("bundleFormStatus").value,
        productIds
      };
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        if (id){
          await fb.updateDoc(fb.doc(fb.db, "bundles", id), { ...payload, updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Bundle updated", message:`"${title}" was saved.` });
          logActivity("bundle-update", `Updated bundle "${title}"`);
        } else {
          await fb.addDoc(fb.collection(fb.db, "bundles"), { ...payload, createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Bundle created", message:`"${title}" was added.` });
          logActivity("bundle-create", `Created bundle "${title}"`);
        }
        window.YF.ui.closeModal("bundleFormModal");
      }catch(err){
        console.error("YF.admin: saveBundle failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save bundle", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Bundle";
      }
    }

    function confirmDeleteBundle(bundleId){
      const bundle = bundlesCache.find(b => b.id === bundleId);
      document.getElementById("deleteBundleId").value = bundleId;
      document.getElementById("deleteBundleTitle").textContent = bundle ? bundle.title : "this bundle";
      window.YF.ui.openModal("deleteBundleModal");
    }

    async function performDeleteBundle(){
      if (!canManage('admin-bundles')) return;
      const id = document.getElementById("deleteBundleId").value;
      if (!id) return;
      const btn = document.getElementById("confirmDeleteBundleBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        await window.YF.firebase.deleteDoc(window.YF.firebase.doc(window.YF.firebase.db, "bundles", id));
        window.YF.ui.toast({ type:"success", title:"Bundle deleted", message:"The bundle was removed." });
        logActivity("bundle-delete", `Deleted bundle ${id}`);
        window.YF.ui.closeModal("deleteBundleModal");
      }catch(err){
        console.error("YF.admin: performDeleteBundle failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete bundle", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    function bindBundlesPage(){
      const tbody = document.getElementById("adminBundlesTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-bundle]");
          const delBtn = e.target.closest("[data-delete-bundle]");
          if (editBtn) openBundleForm("edit", editBtn.dataset.editBundle);
          if (delBtn) confirmDeleteBundle(delBtn.dataset.deleteBundle);
        });
        tbody.dataset.bound = "true";
      }
      const newBtn = document.getElementById("adminNewBundleBtn");
      if (newBtn && newBtn.dataset.bound !== "true"){
        newBtn.addEventListener("click", () => openBundleForm("create"));
        newBtn.dataset.bound = "true";
      }
      const form = document.getElementById("bundleForm");
      if (form && form.dataset.bound !== "true"){
        form.addEventListener("submit", saveBundle);
        form.dataset.bound = "true";
      }
      const confirmDelBtn = document.getElementById("confirmDeleteBundleBtn");
      if (confirmDelBtn && confirmDelBtn.dataset.bound !== "true"){
        confirmDelBtn.addEventListener("click", performDeleteBundle);
        confirmDelBtn.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminBundleSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { bundleSearch = e.target.value; renderBundlesTable(); });
        searchInput.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-bundles". */
    function renderAdminBundlesPage(){
      if (!canManage('admin-bundles')){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindBundlesPage();
      // FIX: the bundle form's product checklist reads productsCache,
      // which was previously only ever populated by visiting Product
      // Management first. Ensure it's loaded here too so Bundles works
      // standalone.
      if (!productsUnsub) subscribeProducts();
      if (!bundlesUnsub) subscribeBundles(); else renderBundlesTable();
    }

    /* ---------------------------------------------------------
       SECTION 23g: REVIEWS MODERATION (added)
       One-time reads via YF.reviews.listAllForAdmin() (not a live
       subscription — reviews don't need second-by-second freshness
       here the way orders/tickets do; the page simply refetches
       after every delete). Delete calls YF.reviews.remove(), which
       recomputes that product's aggregate rating for you.
       --------------------------------------------------------- */
    let reviewsModCache = [];
    let reviewsModSearch = "";

    function getFilteredReviewsMod(){
      const q = reviewsModSearch.trim().toLowerCase();
      if (!q) return reviewsModCache;
      return reviewsModCache.filter(r =>
        String(r.productId || "").toLowerCase().includes(q) ||
        String(r.userName || "").toLowerCase().includes(q)
      );
    }

    function reviewsModDateLabel(r){
      const t = (r.createdAt && r.createdAt.toMillis) ? r.createdAt.toMillis() : (typeof r.createdAt === "number" ? r.createdAt : 0);
      return t ? new Date(t).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" }) : "—";
    }

    function renderAdminReviewsTable(){
      const tbody = document.getElementById("adminReviewsTableBody");
      if (!tbody) return;
      const list = getFilteredReviewsMod();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="6"><div class="admin-empty-state">No reviews match this view.</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(r => {
        const product = productsCache.find(p => p.id === r.productId);
        return `
        <tr>
          <td class="u-text-muted">${escapeHtml(product ? product.title : r.productId)}</td>
          <td>${escapeHtml(r.userName || "Anonymous")}</td>
          <td>${"★".repeat(Math.round(r.rating || 0))}${"☆".repeat(5 - Math.round(r.rating || 0))}</td>
          <td class="u-text-muted" style="max-width:320px;">${escapeHtml((r.comment || "—").slice(0, 200))}</td>
          <td class="u-text-muted">${reviewsModDateLabel(r)}</td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-review-mod="${escapeHtml(r.id)}" data-review-mod-product="${escapeHtml(r.productId)}">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join("");
    }

    async function loadAdminReviews(){
      reviewsModCache = (window.YF.reviews && window.YF.reviews.listAllForAdmin) ? await window.YF.reviews.listAllForAdmin() : [];
      renderAdminReviewsTable();
    }

    async function deleteReviewMod(reviewId, productId){
      if (!isAdmin()) return;
      const btn = document.querySelector(`[data-delete-review-mod="${reviewId}"]`);
      if (btn){ btn.disabled = true; btn.textContent = "Deleting…"; }
      try{
        await window.YF.reviews.remove(reviewId, productId);
        window.YF.ui.toast({ type:"success", title:"Review deleted", message:"The review was removed and the product rating recalculated." });
        logActivity("review-delete", `Deleted review ${reviewId}`);
        await loadAdminReviews();
      }catch(err){
        console.error("YF.admin: deleteReviewMod failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete review", message: err.message || "Please try again." });
        if (btn){ btn.disabled = false; btn.textContent = "Delete"; }
      }
    }

    function bindReviewsModPage(){
      const tbody = document.getElementById("adminReviewsTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-delete-review-mod]");
          if (!btn) return;
          if (!confirm("Delete this review permanently?")) return;
          deleteReviewMod(btn.dataset.deleteReviewMod, btn.dataset.reviewModProduct);
        });
        tbody.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminReviewsSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { reviewsModSearch = e.target.value; renderAdminReviewsTable(); });
        searchInput.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-reviews-mod". */
    function renderReviewsModPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindReviewsModPage();
      if (!productsUnsub) subscribeProducts();
      loadAdminReviews();
    }

    /* ---------------------------------------------------------
       TRADING BROKERS MANAGEMENT (Affiliate Broker System)
       Full CRUD against a top-level "trading_brokers" Firestore
       collection — see YF.brokers for the public read-only side and
       the click-tracking / affiliate-link-opening logic. Every write
       here is gated by isAdmin() client-side AND must be mirrored
       server-side by a Firestore rule such as:
         match /trading_brokers/{id} {
           allow read: if true;
           allow create, update, delete: if request.auth != null && isAdmin();
         }
       Logo uploads go through the SAME Cloudinary pipeline as every
       other upload field in this file (see UPLOAD_FIELD_MAP's
       "brokerLogo" entry + handleFileUpload) — never Firebase
       Storage, never base64. NOTE: true deletion of an old logo FROM
       Cloudinary itself would need a signed server-side call (a
       Cloudinary API secret must never be shipped to the browser),
       which this no-backend architecture doesn't have — so "removing"
       a logo here only clears the reference in Firestore; the old
       Cloudinary asset itself is simply left unreferenced.
       --------------------------------------------------------- */
    let brokersCache = [];
    let brokersUnsub = null;
    let brokerSearch = "";
    let brokerCategoryFilterVal = "all";
    let brokerStatusFilterVal = "all";
    const selectedBrokerIds = new Set();

    const BROKER_CATEGORY_LABELS = {
      forex: "Forex", "binary-options": "Binary Options", crypto: "Crypto",
      stocks: "Stocks", cfd: "CFD", other: "Other"
    };

    function subscribeBrokersAdmin(){
      const fb = window.YF.firebase;
      if (brokersUnsub){ try{ brokersUnsub(); }catch(e){} brokersUnsub = null; }
      if (!(fb && fb.db && fb.collection && fb.onSnapshot)){
        brokersCache = [];
        renderBrokersTable();
        return;
      }
      try{
        brokersUnsub = fb.onSnapshot(fb.collection(fb.db, "trading_brokers"), (snap) => {
          brokersCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0));
          renderBrokersTable();
        }, (err) => {
          console.error("YF.admin: brokers onSnapshot error", err);
          brokersCache = [];
          renderBrokersTable();
        });
      }catch(err){
        console.error("YF.admin: subscribeBrokersAdmin failed", err);
        brokersCache = [];
        renderBrokersTable();
      }
    }

    function escapeHtmlBroker(str){
      return String(str == null ? "" : str)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function brokerRowHTML(b, index, list){
      const badges = [
        b.featured ? `<span class="chip" style="background:var(--c-gold-300); color:#1a1200;">Featured</span>` : "",
        b.popular ? `<span class="chip">Popular</span>` : "",
        b.newBroker ? `<span class="chip">New</span>` : ""
      ].filter(Boolean).join(" ") || `<span class="u-text-muted" style="font-size:var(--fs-xs);">—</span>`;
      const isChecked = selectedBrokerIds.has(b.id);
      const isFirst = index === 0;
      const isLast = index === list.length - 1;
      return `
        <tr>
          <td><input type="checkbox" class="broker-row-checkbox" data-broker-checkbox="${b.id}" ${isChecked ? "checked" : ""}></td>
          <td><img src="${escapeHtmlBroker(b.brokerLogo) || window.YF_NO_IMAGE}" alt="" style="width:32px; height:32px; border-radius:var(--r-sm); object-fit:contain; background:var(--glass-bg);"></td>
          <td>${escapeHtmlBroker(b.brokerName)}</td>
          <td>${escapeHtmlBroker(BROKER_CATEGORY_LABELS[b.category] || b.category || "Other")}</td>
          <td>${Number(b.rating || 0).toFixed(1)} / 5</td>
          <td>$${Number(b.minimumDeposit || 0).toFixed(0)}</td>
          <td>${badges}</td>
          <td><span class="status-badge ${b.active !== false ? "status-badge--active" : ""}">${b.active !== false ? "Active" : "Inactive"}</span></td>
          <td>${Number(b.totalClicks || 0)}</td>
          <td>
            <div style="display:flex; gap:2px;">
              <button class="yf-icon-btn" style="width:26px;height:26px;" type="button" data-move-broker-up="${b.id}" ${isFirst ? "disabled" : ""} aria-label="Move up">↑</button>
              <button class="yf-icon-btn" style="width:26px;height:26px;" type="button" data-move-broker-down="${b.id}" ${isLast ? "disabled" : ""} aria-label="Move down">↓</button>
            </div>
          </td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn btn--outline btn--sm" type="button" data-edit-broker="${b.id}">Edit</button>
              <button class="btn btn--outline btn--sm" type="button" data-duplicate-broker="${b.id}">Duplicate</button>
              <button class="btn btn--outline btn--sm" type="button" data-toggle-broker-active="${b.id}">${b.active !== false ? "Disable" : "Enable"}</button>
              <button class="btn btn--danger btn--sm" type="button" data-delete-broker="${b.id}">Delete</button>
            </div>
          </td>
        </tr>`;
    }

    function filteredBrokers(){
      const q = brokerSearch.trim().toLowerCase();
      return brokersCache.filter(b => {
        if (q && !String(b.brokerName || "").toLowerCase().includes(q)) return false;
        if (brokerCategoryFilterVal !== "all" && b.category !== brokerCategoryFilterVal) return false;
        if (brokerStatusFilterVal === "active" && b.active === false) return false;
        if (brokerStatusFilterVal === "inactive" && b.active !== false) return false;
        return true;
      });
    }

    function renderBrokersTable(){
      const tbody = document.getElementById("adminBrokersTableBody");
      if (!tbody) return;
      const list = filteredBrokers();
      tbody.innerHTML = list.length
        ? list.map((b, i) => brokerRowHTML(b, i, list)).join("")
        : `<tr><td colspan="11"><div class="admin-empty-state">${brokersCache.length ? "No brokers match your filters." : "No brokers yet — click \"Add Broker\" to create your first one."}</div></td></tr>`;
      updateBrokerBulkBar();
    }

    function updateBrokerBulkBar(){
      const bar = document.getElementById("adminBrokerBulkBar");
      const countEl = document.getElementById("adminBrokerBulkCount");
      if (!bar) return;
      bar.classList.toggle("u-hidden", selectedBrokerIds.size === 0);
      if (countEl) countEl.textContent = String(selectedBrokerIds.size);
    }

    function resetBrokerForm(){
      const form = document.getElementById("brokerForm");
      if (form) form.reset();
      document.getElementById("brokerFormId").value = "";
      document.getElementById("brokerFormLogoPublicId").value = "";
      document.getElementById("brokerFormActive").checked = true;
      document.getElementById("brokerFormButtonColor").value = "#d4af37";
      document.getElementById("brokerFormButtonColorHex").value = "#d4af37";
      resetUploadUI("brokerLogo");
    }

    function openBrokerForm(mode, brokerId){
      resetBrokerForm();
      const title = document.getElementById("brokerFormModalTitle");
      if (mode === "edit" || mode === "duplicate"){
        const b = brokersCache.find(x => x.id === brokerId);
        if (!b) return;
        document.getElementById("brokerFormId").value = mode === "edit" ? b.id : "";
        document.getElementById("brokerFormLogoPublicId").value = b.cloudinaryPublicId || "";
        document.getElementById("brokerFormName").value = mode === "duplicate" ? (b.brokerName + " (Copy)") : (b.brokerName || "");
        document.getElementById("brokerFormLogoUrl").value = b.brokerLogo || "";
        if (b.brokerLogo) setUploadDoneUI("brokerLogo", "current logo", 0, b.brokerLogo);
        document.getElementById("brokerFormAffiliateLink").value = b.affiliateLink || "";
        document.getElementById("brokerFormWebsite").value = b.website || "";
        document.getElementById("brokerFormShortDesc").value = b.shortDescription || "";
        document.getElementById("brokerFormFullDesc").value = b.fullDescription || "";
        document.getElementById("brokerFormCategory").value = b.category || "forex";
        document.getElementById("brokerFormPlatformType").value = b.platformType || "";
        document.getElementById("brokerFormMinDeposit").value = b.minimumDeposit != null ? b.minimumDeposit : "";
        document.getElementById("brokerFormMinWithdrawal").value = b.minimumWithdrawal != null ? b.minimumWithdrawal : "";
        document.getElementById("brokerFormRegulation").value = b.regulation || "";
        document.getElementById("brokerFormCountry").value = b.country || "";
        document.getElementById("brokerFormRating").value = b.rating != null ? b.rating : 0;
        document.getElementById("brokerFormCommission").value = b.commission || "";
        document.getElementById("brokerFormButtonText").value = b.buttonText || "Open Account";
        document.getElementById("brokerFormButtonColor").value = b.buttonColor || "#d4af37";
        document.getElementById("brokerFormButtonColorHex").value = b.buttonColor || "#d4af37";
        document.getElementById("brokerFormDemoAccount").checked = !!b.demoAccount;
        document.getElementById("brokerFormFeatured").checked = mode === "duplicate" ? false : !!b.featured;
        document.getElementById("brokerFormPopular").checked = !!b.popular;
        document.getElementById("brokerFormNewBroker").checked = !!b.newBroker;
        document.getElementById("brokerFormActive").checked = mode === "duplicate" ? false : (b.active !== false);
        title.textContent = mode === "edit" ? "Edit Broker" : "Duplicate Broker";
      } else {
        title.textContent = "New Broker";
      }
      window.YF.ui.openModal("brokerFormModal");
    }

    function isValidUrl(str){
      try{ const u = new URL(str); return u.protocol === "http:" || u.protocol === "https:"; }catch(e){ return false; }
    }

    async function saveBroker(e){
      e.preventDefault();
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const id = document.getElementById("brokerFormId").value;
      const brokerName = document.getElementById("brokerFormName").value.trim().slice(0, 100);
      const affiliateLink = document.getElementById("brokerFormAffiliateLink").value.trim();
      const website = document.getElementById("brokerFormWebsite").value.trim();

      if (!brokerName){
        window.YF.ui.toast({ type:"danger", title:"Name required", message:"Please enter the broker's name." });
        return;
      }
      // Prevent duplicate broker names (case-insensitive), excluding the
      // document currently being edited.
      const dup = brokersCache.some(b => b.id !== id && String(b.brokerName || "").trim().toLowerCase() === brokerName.toLowerCase());
      if (dup){
        window.YF.ui.toast({ type:"danger", title:"Duplicate broker", message:"A broker with this name already exists." });
        return;
      }
      if (!affiliateLink || !isValidUrl(affiliateLink)){
        window.YF.ui.toast({ type:"danger", title:"Invalid affiliate link", message:"Please enter a valid http:// or https:// affiliate link." });
        return;
      }
      if (website && !isValidUrl(website)){
        window.YF.ui.toast({ type:"danger", title:"Invalid website URL", message:"Please enter a valid http:// or https:// website URL, or leave it blank." });
        return;
      }

      const payload = {
        brokerName,
        brokerLogo: document.getElementById("brokerFormLogoUrl").value.trim(),
        cloudinaryPublicId: document.getElementById("brokerFormLogoPublicId").value.trim() || null,
        affiliateLink,
        website: website || null,
        shortDescription: document.getElementById("brokerFormShortDesc").value.trim().slice(0, 160),
        fullDescription: document.getElementById("brokerFormFullDesc").value.trim().slice(0, 2000),
        category: document.getElementById("brokerFormCategory").value,
        platformType: document.getElementById("brokerFormPlatformType").value.trim().slice(0, 100),
        minimumDeposit: Number(document.getElementById("brokerFormMinDeposit").value) || 0,
        minimumWithdrawal: Number(document.getElementById("brokerFormMinWithdrawal").value) || 0,
        demoAccount: document.getElementById("brokerFormDemoAccount").checked,
        regulation: document.getElementById("brokerFormRegulation").value.trim().slice(0, 150),
        country: document.getElementById("brokerFormCountry").value.trim().slice(0, 100),
        rating: Math.max(0, Math.min(5, Number(document.getElementById("brokerFormRating").value) || 0)),
        featured: document.getElementById("brokerFormFeatured").checked,
        popular: document.getElementById("brokerFormPopular").checked,
        newBroker: document.getElementById("brokerFormNewBroker").checked,
        buttonText: document.getElementById("brokerFormButtonText").value.trim().slice(0, 40) || "Open Account",
        buttonColor: document.getElementById("brokerFormButtonColorHex").value.trim() || document.getElementById("brokerFormButtonColor").value || "#d4af37",
        commission: document.getElementById("brokerFormCommission").value.trim().slice(0, 100),
        active: document.getElementById("brokerFormActive").checked
      };

      const btn = document.getElementById("brokerFormSubmitBtn");
      if (btn){ btn.disabled = true; btn.textContent = "Saving…"; }
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        if (id){
          await fb.updateDoc(fb.doc(fb.db, "trading_brokers", id), { ...payload, updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Broker updated", message:`"${brokerName}" was saved.` });
          logActivity("broker-update", `Updated broker "${brokerName}"`);
        } else {
          await fb.addDoc(fb.collection(fb.db, "trading_brokers"), {
            ...payload,
            displayOrder: brokersCache.length,
            totalClicks: 0,
            totalRegistrations: 0,
            monthlyEarnings: 0,
            totalEarnings: 0,
            createdAt: fb.serverTimestamp(),
            updatedAt: fb.serverTimestamp()
          });
          window.YF.ui.toast({ type:"success", title:"Broker created", message:`"${brokerName}" was added.` });
          logActivity("broker-create", `Created broker "${brokerName}"`);
        }
        window.YF.ui.closeModal("brokerFormModal");
      }catch(err){
        console.error("YF.admin: saveBroker failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save broker", message: err.message || "Please try again." });
      }finally{
        if (btn){ btn.disabled = false; btn.textContent = "Save Broker"; }
      }
    }

    function confirmDeleteBroker(brokerId){
      const b = brokersCache.find(x => x.id === brokerId);
      if (!b) return;
      document.getElementById("deleteBrokerId").value = brokerId;
      document.getElementById("deleteBrokerName").textContent = b.brokerName || "this broker";
      window.YF.ui.openModal("deleteBrokerModal");
    }

    async function performDeleteBroker(){
      const fb = window.YF.firebase;
      const id = document.getElementById("deleteBrokerId").value;
      if (!id) return;
      const btn = document.getElementById("confirmDeleteBrokerBtn");
      if (btn){ btn.disabled = true; btn.textContent = "Deleting…"; }
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        await fb.deleteDoc(fb.doc(fb.db, "trading_brokers", id));
        selectedBrokerIds.delete(id);
        window.YF.ui.toast({ type:"success", title:"Broker deleted", message:"The broker was permanently removed." });
        logActivity("broker-delete", `Deleted broker (${id})`);
        window.YF.ui.closeModal("deleteBrokerModal");
      }catch(err){
        console.error("YF.admin: deleteBroker failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete broker", message: err.message || "Please try again." });
      }finally{
        if (btn){ btn.disabled = false; btn.textContent = "Delete Permanently"; }
      }
    }

    async function toggleBrokerActive(brokerId){
      const fb = window.YF.firebase;
      const b = brokersCache.find(x => x.id === brokerId);
      if (!b) return;
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        await fb.updateDoc(fb.doc(fb.db, "trading_brokers", brokerId), { active: b.active === false, updatedAt: fb.serverTimestamp() });
        logActivity("broker-toggle", `${b.active === false ? "Enabled" : "Disabled"} broker "${b.brokerName}"`);
      }catch(err){
        console.error("YF.admin: toggleBrokerActive failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't update broker", message: err.message || "Please try again." });
      }
    }

    async function moveBrokerOrder(brokerId, direction){
      const list = filteredBrokers();
      const idx = list.findIndex(b => b.id === brokerId);
      if (idx === -1) return;
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= list.length) return;
      const a = list[idx], b = list[swapIdx];
      const fb = window.YF.firebase;
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        const aOrder = Number(a.displayOrder) || 0;
        const bOrder = Number(b.displayOrder) || 0;
        await Promise.all([
          fb.updateDoc(fb.doc(fb.db, "trading_brokers", a.id), { displayOrder: bOrder }),
          fb.updateDoc(fb.doc(fb.db, "trading_brokers", b.id), { displayOrder: aOrder })
        ]);
      }catch(err){
        console.error("YF.admin: moveBrokerOrder failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't reorder", message: err.message || "Please try again." });
      }
    }

    async function bulkActivateBrokers(activate){
      const fb = window.YF.firebase;
      if (!(fb && fb.db) || !selectedBrokerIds.size) return;
      try{
        await Promise.all(Array.from(selectedBrokerIds).map(id =>
          fb.updateDoc(fb.doc(fb.db, "trading_brokers", id), { active: activate, updatedAt: fb.serverTimestamp() }).catch(() => {})
        ));
        window.YF.ui.toast({ type:"success", title: activate ? "Brokers activated" : "Brokers deactivated", message:`${selectedBrokerIds.size} broker(s) updated.` });
        selectedBrokerIds.clear();
        renderBrokersTable();
      }catch(err){
        console.error("YF.admin: bulkActivateBrokers failed", err);
        window.YF.ui.toast({ type:"danger", title:"Bulk update failed", message: err.message || "Please try again." });
      }
    }

    async function bulkDeleteBrokers(){
      const fb = window.YF.firebase;
      if (!(fb && fb.db) || !selectedBrokerIds.size) return;
      try{
        await Promise.all(Array.from(selectedBrokerIds).map(id =>
          fb.deleteDoc(fb.doc(fb.db, "trading_brokers", id)).catch(() => {})
        ));
        window.YF.ui.toast({ type:"success", title:"Brokers deleted", message:`${selectedBrokerIds.size} broker(s) permanently removed.` });
        selectedBrokerIds.clear();
        renderBrokersTable();
      }catch(err){
        console.error("YF.admin: bulkDeleteBrokers failed", err);
        window.YF.ui.toast({ type:"danger", title:"Bulk delete failed", message: err.message || "Please try again." });
      }
    }

    function populateBrokerCategoryFilters(){
      ["adminBrokerCategoryFilter"].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel || sel.dataset.populated === "true") return;
        Object.entries(BROKER_CATEGORY_LABELS).forEach(([val, label]) => {
          const opt = document.createElement("option");
          opt.value = val; opt.textContent = label;
          sel.appendChild(opt);
        });
        sel.dataset.populated = "true";
      });
    }

    function bindBrokersPage(){
      populateBrokerCategoryFilters();
      const tbody = document.getElementById("adminBrokersTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-broker]");
          const dupBtn = e.target.closest("[data-duplicate-broker]");
          const delBtn = e.target.closest("[data-delete-broker]");
          const toggleBtn = e.target.closest("[data-toggle-broker-active]");
          const upBtn = e.target.closest("[data-move-broker-up]");
          const downBtn = e.target.closest("[data-move-broker-down]");
          if (editBtn) openBrokerForm("edit", editBtn.dataset.editBroker);
          if (dupBtn) openBrokerForm("duplicate", dupBtn.dataset.duplicateBroker);
          if (delBtn) confirmDeleteBroker(delBtn.dataset.deleteBroker);
          if (toggleBtn) toggleBrokerActive(toggleBtn.dataset.toggleBrokerActive);
          if (upBtn) moveBrokerOrder(upBtn.dataset.moveBrokerUp, "up");
          if (downBtn) moveBrokerOrder(downBtn.dataset.moveBrokerDown, "down");
        });
        tbody.addEventListener("change", (e) => {
          const cb = e.target.closest("[data-broker-checkbox]");
          if (!cb) return;
          if (cb.checked) selectedBrokerIds.add(cb.dataset.brokerCheckbox);
          else selectedBrokerIds.delete(cb.dataset.brokerCheckbox);
          updateBrokerBulkBar();
        });
        tbody.dataset.bound = "true";
      }
      const newBtn = document.getElementById("adminNewBrokerBtn");
      if (newBtn && newBtn.dataset.bound !== "true"){
        newBtn.addEventListener("click", () => openBrokerForm("create"));
        newBtn.dataset.bound = "true";
      }
      const form = document.getElementById("brokerForm");
      if (form && form.dataset.bound !== "true"){
        form.addEventListener("submit", saveBroker);
        form.dataset.bound = "true";
      }
      const confirmDelBtn = document.getElementById("confirmDeleteBrokerBtn");
      if (confirmDelBtn && confirmDelBtn.dataset.bound !== "true"){
        confirmDelBtn.addEventListener("click", performDeleteBroker);
        confirmDelBtn.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminBrokerSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { brokerSearch = e.target.value; renderBrokersTable(); });
        searchInput.dataset.bound = "true";
      }
      const catFilter = document.getElementById("adminBrokerCategoryFilter");
      if (catFilter && catFilter.dataset.bound !== "true"){
        catFilter.addEventListener("change", (e) => { brokerCategoryFilterVal = e.target.value; renderBrokersTable(); });
        catFilter.dataset.bound = "true";
      }
      const statusFilter = document.getElementById("adminBrokerStatusFilter");
      if (statusFilter && statusFilter.dataset.bound !== "true"){
        statusFilter.addEventListener("change", (e) => { brokerStatusFilterVal = e.target.value; renderBrokersTable(); });
        statusFilter.dataset.bound = "true";
      }
      const selectAll = document.getElementById("adminBrokerSelectAll");
      if (selectAll && selectAll.dataset.bound !== "true"){
        selectAll.addEventListener("change", (e) => {
          if (e.target.checked) filteredBrokers().forEach(b => selectedBrokerIds.add(b.id));
          else selectedBrokerIds.clear();
          renderBrokersTable();
        });
        selectAll.dataset.bound = "true";
      }
      const bulkActivateBtn = document.getElementById("adminBrokerBulkActivateBtn");
      if (bulkActivateBtn && bulkActivateBtn.dataset.bound !== "true"){
        bulkActivateBtn.addEventListener("click", () => bulkActivateBrokers(true));
        bulkActivateBtn.dataset.bound = "true";
      }
      const bulkDeactivateBtn = document.getElementById("adminBrokerBulkDeactivateBtn");
      if (bulkDeactivateBtn && bulkDeactivateBtn.dataset.bound !== "true"){
        bulkDeactivateBtn.addEventListener("click", () => bulkActivateBrokers(false));
        bulkDeactivateBtn.dataset.bound = "true";
      }
      const bulkDeleteBtn = document.getElementById("adminBrokerBulkDeleteBtn");
      if (bulkDeleteBtn && bulkDeleteBtn.dataset.bound !== "true"){
        bulkDeleteBtn.addEventListener("click", () => {
          if (confirm(`Delete ${selectedBrokerIds.size} selected broker(s)? This cannot be undone.`)) bulkDeleteBrokers();
        });
        bulkDeleteBtn.dataset.bound = "true";
      }
      bindExtraUploadInputs([{ field: "brokerLogo", removeBtnId: "brokerFormLogoRemoveBtn", urlInputId: "brokerFormLogoUrl" }]);
      const colorPicker = document.getElementById("brokerFormButtonColor");
      const colorHex = document.getElementById("brokerFormButtonColorHex");
      if (colorPicker && colorPicker.dataset.bound !== "true"){
        colorPicker.addEventListener("input", () => { if (colorHex) colorHex.value = colorPicker.value; });
        colorPicker.dataset.bound = "true";
      }
      if (colorHex && colorHex.dataset.bound !== "true"){
        colorHex.addEventListener("input", () => { if (colorPicker && /^#[0-9a-fA-F]{6}$/.test(colorHex.value)) colorPicker.value = colorHex.value; });
        colorHex.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-brokers". */
    function renderBrokersPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindBrokersPage();
      if (!brokersUnsub) subscribeBrokersAdmin(); else renderBrokersTable();
    }

    /* ---------------------------------------------------------
       USER MANAGEMENT
       Full CRUD/moderation against the top-level "users" Firestore
       collection. Every write is gated by isAdmin() here AND must
       be mirrored server-side by a Firestore rule, e.g.:
         match /users/{uid} {
           allow read:  if request.auth != null && (request.auth.uid == uid || isAdmin());
           allow write: if request.auth != null && (request.auth.uid == uid || isAdmin());
         }
       Deleting here only removes the Firestore PROFILE document —
       a Firebase Auth account can't be deleted from client-side
       code (that needs the Admin SDK / a Cloud Function), so a
       "deleted" user's sign-in credentials would still exist until
       that's run separately — called out in the UI copy.
       Self-protection: an admin can never suspend/ban/demote/
       delete the account they're CURRENTLY signed in as from this
       page — isSelf() blocks those actions client-side before any
       write is attempted, and the row's actions are hidden for
       their own uid entirely.
       --------------------------------------------------------- */

    function isSelf(uid){
      return !!(window.YF.auth && window.YF.auth.currentUser && window.YF.auth.currentUser.uid === uid);
    }

    function userInitials(name, email){
      const src = (name || "").trim() || (email || "").trim();
      if (!src) return "?";
      const parts = src.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return src.slice(0, 2).toUpperCase();
    }

    function roleBadge(role){
      const r = role === "admin" ? "admin" : "user";
      return `<span class="role-badge role-badge--${r}">${r}</span>`;
    }

    function userStatusBadge(status){
      const s = status || "active";
      const labels = { active: "Active", suspended: "Suspended", banned: "Banned" };
      return `<span class="status-badge status-badge--${s}">${labels[s] || s}</span>`;
    }

    function userDateLabel(u){
      const t = (u.createdAt && u.createdAt.toMillis) ? u.createdAt.toMillis() : (typeof u.createdAt === "number" ? u.createdAt : 0);
      return t ? new Date(t).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" }) : "—";
    }

    /** Starts (once) a live subscription to every user profile
     *  document. Reused by both the User Management page and
     *  Global Search (for admins), so opening either keeps the
     *  other's data fresh — same "one shared listener" pattern
     *  subscribeOrders() already uses for Payments. */
    function subscribeUsers(){
      const fb = window.YF.firebase;
      if (usersUnsub){ try{ usersUnsub(); }catch(e){} usersUnsub = null; }
      if (!(fb && fb.db && fb.collection && fb.onSnapshot)){
        usersCache = [];
        renderUsersTable();
        return;
      }
      try{
        usersUnsub = fb.onSnapshot(fb.collection(fb.db, "users"), (snap) => {
          usersCache = snap.docs.map(d => {
            const data = d.data();
            return {
              uid: d.id,
              name: data.name || data.displayName || "",
              email: data.email || "",
              role: data.role || "user",
              status: data.status || "active",
              statusReason: data.statusReason || "",
              photoURL: data.photoURL || "",
              createdAt: (data.createdAt && data.createdAt.toMillis) ? data.createdAt.toMillis() : (data.createdAt || 0)
            };
          }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          renderUsersTable();
        }, (err) => {
          console.error("YF.admin: users onSnapshot error", err);
          usersCache = [];
          renderUsersTable();
        });
      }catch(err){
        console.error("YF.admin: subscribeUsers failed", err);
        usersCache = [];
        renderUsersTable();
      }
    }

    /** Idempotent — lazily starts the users subscription so Global
     *  Search can show live user results for admins even if User
     *  Management was never opened this session. Always re-checks
     *  isAdmin() itself rather than trusting the caller. */
    function ensureUsersLoaded(){
      if (!isAdmin()) return;
      if (!usersUnsub) subscribeUsers();
    }

    function getUsersCache(){ return usersCache; }

    function getFilteredUsers(){
      const q = userFilters.search.trim().toLowerCase();
      return usersCache.filter(u => {
        if (userFilters.role !== "all" && (u.role || "user") !== userFilters.role) return false;
        if (userFilters.status !== "all" && (u.status || "active") !== userFilters.status) return false;
        if (q){
          const hay = `${u.name || ""} ${u.email || ""} ${u.uid}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function renderUsersTable(){
      const tbody = document.getElementById("adminUsersTableBody");
      if (!tbody) return;
      const list = getFilteredUsers();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="6"><div class="admin-empty-state">${
          usersCache.length ? "No users match this view." : "No registered users yet."
        }</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(u => {
        const self = isSelf(u.uid);
        const isSuspended = u.status === "suspended";
        const isBanned = u.status === "banned";
        const actions = [];
        actions.push(`<button type="button" class="admin-action-btn" data-view-activity="${u.uid}">Activity</button>`);
        actions.push(`<button type="button" class="admin-action-btn" data-adjust-wallet="${u.uid}">Wallet</button>`);
        if (!self){
          if (isBanned){
            actions.push(`<button type="button" class="admin-action-btn admin-action-btn--success" data-user-action="unban" data-uid="${u.uid}">Unban</button>`);
          } else {
            actions.push(`<button type="button" class="admin-action-btn admin-action-btn--danger" data-user-action="ban" data-uid="${u.uid}">Ban</button>`);
            actions.push(isSuspended
              ? `<button type="button" class="admin-action-btn admin-action-btn--success" data-user-action="reactivate" data-uid="${u.uid}">Reactivate</button>`
              : `<button type="button" class="admin-action-btn" data-user-action="suspend" data-uid="${u.uid}">Suspend</button>`);
          }
          actions.push(`
            <select class="form-input" style="max-width:150px;display:inline-block;height:32px;padding:2px 6px;" data-role-select="${u.uid}" data-prev-role="${u.role || "user"}">
              <option value="user" ${(!u.role || u.role === "user") ? "selected" : ""}>User</option>
              <option value="support" ${u.role === "support" ? "selected" : ""}>Support Agent</option>
              <option value="product_manager" ${u.role === "product_manager" ? "selected" : ""}>Product Manager</option>
              <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
            </select>`);
          actions.push(`<button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-user="${u.uid}">Delete</button>`);
        } else {
          actions.push(`<span class="u-text-muted" style="font-size:var(--fs-xs);">(you)</span>`);
        }
        return `
        <tr data-user-row="${u.uid}">
          <td>
            <div class="user-row__info">
              ${u.photoURL
                ? `<img class="user-row__avatar" src="${escapeHtml(u.photoURL)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
                : `<div class="user-row__avatar">${escapeHtml(userInitials(u.name, u.email))}</div>`
              }
              <div>
                <div class="user-row__name">${escapeHtml(u.name || "Unnamed user")}</div>
                <div class="user-row__uid">${escapeHtml(u.uid)}</div>
              </div>
            </div>
          </td>
          <td class="u-text-muted">${escapeHtml(u.email || "—")}</td>
          <td>${roleBadge(u.role)}</td>
          <td>${userStatusBadge(u.status)}</td>
          <td class="u-text-muted">${userDateLabel(u)}</td>
          <td><div class="admin-row-actions">${actions.join("")}</div></td>
        </tr>`;
      }).join("");
    }

    /** Opens the shared suspend/ban/reactivate/unban/promote/demote
     *  modal. isSelf() is checked FIRST — before the modal ever
     *  opens — so an admin can't even reach the confirm step for
     *  their own account. */
    function openUserStatusAction(uid, action){
      if (isSelf(uid)){
        window.YF.ui.toast({ type:"danger", title:"Not allowed", message:"You can't change your own account's status or role from here." });
        return;
      }
      const u = usersCache.find(x => x.uid === uid);
      if (!u) return;
      document.getElementById("userActionUid").value = uid;
      document.getElementById("userActionType").value = action;
      document.getElementById("userActionReason").value = "";
      const titleEl = document.getElementById("userStatusActionModalTitle");
      const descEl = document.getElementById("userActionDesc");
      const confirmBtn = document.getElementById("confirmUserActionBtn");
      const reasonGroup = document.getElementById("userActionReasonGroup");
      const name = u.name || u.email || u.uid;
      const copy = {
        suspend:    { title: "Suspend User",      desc: `${name} will be temporarily blocked from signing in.`, btn: "Suspend User",      showReason: true  },
        ban:        { title: "Ban User",          desc: `${name} will be permanently blocked from the platform.`, btn: "Ban User",          showReason: true  },
        reactivate: { title: "Reactivate User",   desc: `${name}'s account will be restored to active.`,        btn: "Reactivate User",   showReason: false },
        unban:      { title: "Unban User",        desc: `${name} will be able to sign in again.`,               btn: "Unban User",        showReason: false },
        promote:    { title: "Promote to Admin",  desc: `${name} will get full admin access, including this User Management page.`, btn: "Promote to Admin", showReason: false },
        demote:     { title: "Demote to User",    desc: `${name} will lose admin access immediately.`,          btn: "Demote to User",    showReason: false }
      }[action] || { title: "Confirm", desc: "", btn: "Confirm", showReason: false };
      titleEl.textContent = copy.title;
      descEl.textContent = copy.desc;
      confirmBtn.textContent = copy.btn;
      confirmBtn.className = (action === "ban" || action === "suspend" || action === "demote") ? "btn btn--danger" : "btn btn--success";
      reasonGroup.classList.toggle("u-hidden", !copy.showReason);
      window.YF.ui.openModal("userStatusActionModal");
    }

    /** SECTION 23g — added. Confirms a role change to any of the four
     *  roles (user/support/product_manager/admin) via the SAME modal
     *  used by suspend/ban/etc above — just with role-specific copy.
     *  Reuses "userActionType" = "set_role" and a new hidden
     *  "userActionNewRole" field for the target role. */
    function openRoleChangeConfirm(uid, newRole){
      if (isSelf(uid)){
        window.YF.ui.toast({ type:"danger", title:"Not allowed", message:"You can't change your own role from here." });
        renderUsersTable(); // revert the select back to its real value
        return;
      }
      const u = usersCache.find(x => x.uid === uid);
      if (!u) return;
      const validRoles = ["user", "support", "product_manager", "admin"];
      if (!validRoles.includes(newRole)) return;
      document.getElementById("userActionUid").value = uid;
      document.getElementById("userActionType").value = "set_role";
      document.getElementById("userActionNewRole").value = newRole;
      document.getElementById("userActionReason").value = "";
      const titleEl = document.getElementById("userStatusActionModalTitle");
      const descEl = document.getElementById("userActionDesc");
      const confirmBtn = document.getElementById("confirmUserActionBtn");
      const reasonGroup = document.getElementById("userActionReasonGroup");
      const name = u.name || u.email || u.uid;
      const roleLabel = (window.YF.roles && window.YF.roles.roleLabel(newRole)) || newRole;
      titleEl.textContent = `Change Role — ${roleLabel}`;
      descEl.textContent = newRole === "admin"
        ? `${name} will get full admin access, including User Management.`
        : newRole === "user"
          ? `${name} will lose all admin panel access.`
          : `${name} will get admin-panel access limited to the ${roleLabel} area only.`;
      confirmBtn.textContent = "Confirm";
      confirmBtn.className = newRole === "user" ? "btn btn--danger" : "btn btn--success";
      reasonGroup.classList.add("u-hidden");
      window.YF.ui.openModal("userStatusActionModal");
    }

    /** Every branch re-verifies isAdmin() AND isSelf() right before
     *  writing — never trusts that the modal's own guard was
     *  enough, since this is the function that actually touches
     *  Firestore. */
    async function performUserStatusAction(){
      if (!isAdmin()) return;
      const fb = window.YF.firebase;
      const uid = document.getElementById("userActionUid").value;
      const action = document.getElementById("userActionType").value;
      const reason = document.getElementById("userActionReason").value.trim();
      if (!uid || isSelf(uid)) return;
      const btn = document.getElementById("confirmUserActionBtn");
      const originalLabel = btn.textContent;
      btn.disabled = true; btn.textContent = "Working…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        const ref = fb.doc(fb.db, "users", uid);
        if (action === "suspend"){
          await fb.updateDoc(ref, { status: "suspended", statusReason: reason, statusUpdatedAt: fb.serverTimestamp() });
        } else if (action === "ban"){
          await fb.updateDoc(ref, { status: "banned", statusReason: reason, statusUpdatedAt: fb.serverTimestamp() });
        } else if (action === "reactivate" || action === "unban"){
          await fb.updateDoc(ref, { status: "active", statusReason: "", statusUpdatedAt: fb.serverTimestamp() });
        } else if (action === "promote"){
          await fb.updateDoc(ref, { role: "admin", roleUpdatedAt: fb.serverTimestamp() });
        } else if (action === "demote"){
          await fb.updateDoc(ref, { role: "user", roleUpdatedAt: fb.serverTimestamp() });
        } else if (action === "set_role"){
          const newRole = document.getElementById("userActionNewRole").value;
          if (!["user", "support", "product_manager", "admin"].includes(newRole)) throw new Error("Invalid role.");
          await fb.updateDoc(ref, { role: newRole, roleUpdatedAt: fb.serverTimestamp() });
        }
        window.YF.ui.toast({ type:"success", title:"User updated", message:"The change was saved." });
        logActivity("user-status", `Set action "${action}" on user ${uid}${reason ? " — " + reason : ""}`);
        window.YF.ui.closeModal("userStatusActionModal");
      }catch(err){
        console.error("YF.admin: performUserStatusAction failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't update user", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = originalLabel;
      }
    }

    function confirmDeleteUser(uid){
      if (isSelf(uid)){
        window.YF.ui.toast({ type:"danger", title:"Not allowed", message:"You can't delete your own account from here." });
        return;
      }
      const u = usersCache.find(x => x.uid === uid);
      if (!u) return;
      document.getElementById("deleteUserId").value = uid;
      document.getElementById("deleteUserLabel").textContent = u.name || u.email || u.uid;
      window.YF.ui.openModal("deleteUserModal");
    }

    async function performDeleteUser(){
      if (!isAdmin()) return;
      const fb = window.YF.firebase;
      const uid = document.getElementById("deleteUserId").value;
      if (!uid || isSelf(uid)) return;
      const btn = document.getElementById("confirmDeleteUserBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        await fb.deleteDoc(fb.doc(fb.db, "users", uid));
        window.YF.ui.toast({ type:"info", title:"User profile deleted", message:"Their Firestore profile was removed. This doesn't revoke their sign-in credentials — that requires a backend Admin SDK call." });
        logActivity("user-delete", `Deleted user profile ${uid}`);
        window.YF.ui.closeModal("deleteUserModal");
      }catch(err){
        console.error("YF.admin: deleteUser failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete user", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    /** Opens the manual wallet credit/debit modal for one user, shown
     *  as a "Wallet" action button next to Activity on every row
     *  except the admin's own. Fetches the live balance fresh each
     *  time rather than trusting any locally cached number. */
    async function openWalletAdjustModal(uid){
      const u = usersCache.find(x => x.uid === uid);
      document.getElementById("walletAdjustUid").value = uid;
      document.getElementById("walletAdjustModalTitle").textContent = `Adjust Wallet — ${u ? (u.name || u.email || uid) : uid}`;
      document.getElementById("walletAdjustCurrentBalance").textContent = "Current balance: loading…";
      document.getElementById("walletAdjustType").value = "credit";
      document.getElementById("walletAdjustAmount").value = "";
      document.getElementById("walletAdjustNote").value = "";
      window.YF.ui.openModal("walletAdjustModal");
      if (window.YF.wallet){
        const bal = await window.YF.wallet.adminGetWalletBalance(uid);
        document.getElementById("walletAdjustCurrentBalance").textContent = `Current balance: ${formatMoney(bal)}`;
      }
    }

    async function performWalletAdjust(e){
      e.preventDefault();
      const uid = document.getElementById("walletAdjustUid").value;
      const type = document.getElementById("walletAdjustType").value;
      const amount = document.getElementById("walletAdjustAmount").value;
      const note = document.getElementById("walletAdjustNote").value;
      const btn = document.getElementById("walletAdjustSubmitBtn");
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        await window.YF.wallet.adminAdjustWallet(uid, type, amount, note);
        window.YF.ui.toast({ type:"success", title:"Wallet updated", message:"The adjustment was applied." });
        window.YF.ui.closeModal("walletAdjustModal");
      }catch(err){
        window.YF.ui.toast({ type:"danger", title:"Couldn't adjust wallet", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Adjustment";
      }
    }

    /** Read-only Activity view — profile summary + this user's
     *  recent orders. Reuses the SAME admin-wide orders
     *  subscription the Payment Approval Queue uses (subscribeOrders()
     *  / ordersCache), filtered client-side to this one uid, rather
     *  than opening a second Firestore listener. */
    function openUserActivity(uid){
      const u = usersCache.find(x => x.uid === uid);
      if (!u) return;
      document.getElementById("userActivityModalTitle").textContent = u.name || "User Activity";
      document.getElementById("userActivitySubtitle").textContent = `${u.email || u.uid} — joined ${userDateLabel(u)}`;
      renderUserActivityBody(uid);
      window.YF.ui.openModal("userActivityModal");
      if (!ordersUnsub) subscribeOrders();
    }

    function renderUserActivityBody(uid){
      const listEl = document.getElementById("userActivityOrdersList");
      const summaryEl = document.getElementById("userActivitySummary");
      if (!listEl || !summaryEl) return;
      const orders = ordersCache.filter(o => o.uid === uid);
      const totalSpent = orders.filter(o => o.status === "approved").reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
      const pending = orders.filter(o => o.status === "pending").length;
      summaryEl.innerHTML = `
        <div class="user-activity-summary__item"><div class="user-activity-summary__num">${orders.length}</div><div class="user-activity-summary__label">Orders</div></div>
        <div class="user-activity-summary__item"><div class="user-activity-summary__num">${formatMoney(totalSpent)}</div><div class="user-activity-summary__label">Total Spent</div></div>
        <div class="user-activity-summary__item"><div class="user-activity-summary__num">${pending}</div><div class="user-activity-summary__label">Pending</div></div>
      `;
      if (!ordersUnsub){
        listEl.innerHTML = `<li><div class="skeleton skeleton--text w-60"></div></li>
<li><div class="skeleton skeleton--text w-40"></div></li>`;
        return;
      }
      if (!orders.length){
        listEl.innerHTML = `<li class="u-text-muted">No orders yet.</li>`;
        return;
      }
      listEl.innerHTML = orders.slice(0, 10).map(o => `
        <li>
          <span>${escapeHtml(o.productTitle || "Product")}</span>
          <span>${orderStatusBadge(o.status)}</span>
        </li>
      `).join("");
    }

    function bindUsersPage(){
      const tbody = document.getElementById("adminUsersTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const activityBtn = e.target.closest("[data-view-activity]");
          const actionBtn = e.target.closest("[data-user-action]");
          const delBtn = e.target.closest("[data-delete-user]");
          const walletBtn = e.target.closest("[data-adjust-wallet]");
          if (activityBtn) openUserActivity(activityBtn.dataset.viewActivity);
          if (actionBtn) openUserStatusAction(actionBtn.dataset.uid, actionBtn.dataset.userAction);
          if (delBtn) confirmDeleteUser(delBtn.dataset.deleteUser);
          if (walletBtn) openWalletAdjustModal(walletBtn.dataset.adjustWallet);
        });
        tbody.dataset.bound = "true";
      }
      // ---- Role change dropdown (SECTION 23g — added) ----
      if (tbody && tbody.dataset.roleBound !== "true"){
        tbody.addEventListener("change", (e) => {
          const sel = e.target.closest("[data-role-select]");
          if (!sel) return;
          const uid = sel.dataset.roleSelect;
          const newRole = sel.value;
          // Revert the visible select immediately — it only reflects
          // the real Firestore value once performUserStatusAction()
          // actually succeeds and the live subscription re-renders
          // this table. Confirming in the modal is what commits it.
          sel.value = sel.dataset.prevRole || "user";
          openRoleChangeConfirm(uid, newRole);
        });
        tbody.dataset.roleBound = "true";
      }
      const walletForm = document.getElementById("walletAdjustForm");
      if (walletForm && walletForm.dataset.bound !== "true"){
        walletForm.addEventListener("submit", performWalletAdjust);
        walletForm.dataset.bound = "true";
      }
      const confirmActionBtn = document.getElementById("confirmUserActionBtn");
      if (confirmActionBtn && confirmActionBtn.dataset.bound !== "true"){
        confirmActionBtn.addEventListener("click", performUserStatusAction);
        confirmActionBtn.dataset.bound = "true";
      }
      const confirmDelBtn = document.getElementById("confirmDeleteUserBtn");
      if (confirmDelBtn && confirmDelBtn.dataset.bound !== "true"){
        confirmDelBtn.addEventListener("click", performDeleteUser);
        confirmDelBtn.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminUserSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { userFilters.search = e.target.value; renderUsersTable(); });
        searchInput.dataset.bound = "true";
      }
      const roleFilter = document.getElementById("adminUserRoleFilter");
      if (roleFilter && roleFilter.dataset.bound !== "true"){
        roleFilter.addEventListener("change", (e) => { userFilters.role = e.target.value; renderUsersTable(); });
        roleFilter.dataset.bound = "true";
      }
      const statusFilter = document.getElementById("adminUserStatusFilter");
      if (statusFilter && statusFilter.dataset.bound !== "true"){
        statusFilter.addEventListener("change", (e) => { userFilters.status = e.target.value; renderUsersTable(); });
        statusFilter.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-users". */
    function renderUsersPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindUsersPage();
      if (!usersUnsub) subscribeUsers(); else renderUsersTable();
    }

    /* ---------------------------------------------------------
       PAYMENT APPROVAL QUEUE
       Reads/writes the same "orders" collection YF.orders already
       manages for buyers — this is the Admin-side counterpart.
       Approve calls YF.orders.approveOrderAndIssueLicense() (the
       Session 8 function) which flips the order to "approved",
       auto-generates a license via YF.licenses.issueLicense(), and
       notifies the buyer. Reject / Refund go through
       YF.orders.rejectOrder() / refundOrder(), which likewise
       notify the buyer via YF.notifications.
       --------------------------------------------------------- */

    function subscribeOrders(){
      if (ordersUnsub){ try{ ordersUnsub(); }catch(e){} ordersUnsub = null; }
      if (!(window.YF.orders && window.YF.orders.subscribeAllOrders)){
        ordersCache = [];
        renderOrdersTable();
        return;
      }
      ordersUnsub = window.YF.orders.subscribeAllOrders((orders) => {
        ordersCache = orders.sort((a, b) => {
          const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : (a.createdAt || 0);
          const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : (b.createdAt || 0);
          return bt - at;
        });
        updatePendingBadge();
        renderOrdersTable();
      });
    }

    function updatePendingBadge(){
      const badge = document.getElementById("adminPendingBadge");
      if (!badge) return;
      const count = ordersCache.filter(o => o.status === "pending").length;
      badge.textContent = String(count);
      badge.classList.toggle("u-hidden", count === 0);
    }

    function getFilteredOrders(){
      const q = orderFilters.search.trim().toLowerCase();
      return ordersCache.filter(o => {
        if (orderFilters.status !== "all" && (o.status || "pending") !== orderFilters.status) return false;
        if (q){
          const hay = `${o.buyerName || ""} ${o.buyerEmail || ""} ${o.productTitle || ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function orderDateLabel(o){
      const t = (o.createdAt && o.createdAt.toMillis) ? o.createdAt.toMillis() : (typeof o.createdAt === "number" ? o.createdAt : 0);
      return t ? new Date(t).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" }) : "—";
    }

    function orderStatusBadge(status){
      const meta = (window.YF.orders && window.YF.orders.ORDER_STATUS_META && window.YF.orders.ORDER_STATUS_META[status])
        || { label: status || "Unknown", badgeClass: "status-badge--pending" };
      return `<span class="status-badge ${meta.badgeClass}">${escapeHtml(meta.label)}</span>`;
    }

    function renderOrdersTable(){
      const tbody = document.getElementById("adminPaymentsTableBody");
      if (!tbody) return;
      const list = getFilteredOrders();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="9"><div class="admin-empty-state">No payments match this view.</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(o => {
        const isPending = (o.status || "pending") === "pending";
        const isApproved = o.status === "approved";
        let actions = `<span class="u-text-muted">—</span>`;
        if (isPending){
          actions = `
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn admin-action-btn--success" data-approve-order="${o.id}">Approve</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-reject-order="${o.id}">Reject</button>
            </div>`;
        } else if (isApproved){
          actions = `
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-refund-order="${o.id}">Refund</button>
            </div>`;
        }
        return `
        <tr data-order-row="${o.id}">
          <td>
            <div class="order-buyer__name">${escapeHtml(o.buyerName || "Unknown buyer")}</div>
            <div class="order-buyer__email">${escapeHtml(o.buyerEmail || "")}</div>
          </td>
          <td class="u-text-muted">${escapeHtml(o.productTitle || "Product")}</td>
          <td class="order-amount">${formatPrice(o.amount)}</td>
          <td class="u-text-muted">${escapeHtml(o.paymentMethodLabel || o.paymentMethodId || "—")}</td>
          <td class="order-txn-id">${escapeHtml(o.transactionId || "—")}</td>
          <td>${o.screenshotURL
            ? `<img class="screenshot-thumb" src="${escapeHtml(o.screenshotURL)}" alt="Payment proof" data-view-screenshot="${escapeHtml(o.screenshotURL)}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
            : `<span class="u-text-muted">—</span>`
          }</td>
          <td>${orderStatusBadge(o.status)}</td>
          <td class="u-text-muted">${orderDateLabel(o)}</td>
          <td>${actions}</td>
        </tr>
      `;
      }).join("");
    }

    /** Approve is a single click (no reason needed) — it immediately
     *  calls the Session 8 license-issuing function and refreshes the
     *  row optimistically via the live onSnapshot listener. */
    async function approvePayment(orderId){
      if (!isAdmin()) return;
      const row = document.querySelector(`[data-order-row="${orderId}"] [data-approve-order]`);
      if (row){ row.disabled = true; row.textContent = "Approving…"; }
      try{
        await window.YF.orders.approveOrderAndIssueLicense(orderId);
        window.YF.ui.toast({ type:"success", title:"Payment approved", message:"License generated and the buyer has been notified." });
        logActivity("payment-approve", `Approved order ${orderId} and issued a license`);
      }catch(err){
        console.error("YF.admin: approvePayment failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't approve payment", message: err.message || "Please try again." });
      }finally{
        if (row){ row.disabled = false; row.textContent = "Approve"; }
      }
    }

    function openOrderAction(orderId, action){
      document.getElementById("orderActionOrderId").value = orderId;
      document.getElementById("orderActionType").value = action;
      document.getElementById("orderActionReason").value = "";
      const titleEl = document.getElementById("orderActionModalTitle");
      const descEl = document.getElementById("orderActionDesc");
      const confirmBtn = document.getElementById("confirmOrderActionBtn");
      if (action === "refund"){
        titleEl.textContent = "Refund Payment";
        descEl.textContent = "This will mark the order as refunded and notify the buyer. It does not automatically revoke their license.";
        confirmBtn.textContent = "Refund Payment";
      } else {
        titleEl.textContent = "Reject Payment";
        descEl.textContent = "This will mark the order as rejected and notify the buyer so they can retry with corrected payment proof.";
        confirmBtn.textContent = "Reject Payment";
      }
      window.YF.ui.openModal("orderActionModal");
    }

    async function performOrderAction(){
      if (!isAdmin()) return;
      const orderId = document.getElementById("orderActionOrderId").value;
      const action = document.getElementById("orderActionType").value;
      const reason = document.getElementById("orderActionReason").value.trim();
      if (!orderId) return;
      const btn = document.getElementById("confirmOrderActionBtn");
      btn.disabled = true; btn.textContent = "Working…";
      try{
        if (action === "refund"){
          await window.YF.orders.refundOrder(orderId, reason);
          window.YF.ui.toast({ type:"info", title:"Payment refunded", message:"The buyer has been notified." });
          logActivity("payment-refund", `Refunded order ${orderId}${reason ? " — " + reason : ""}`);
        } else {
          await window.YF.orders.rejectOrder(orderId, reason);
          window.YF.ui.toast({ type:"info", title:"Payment rejected", message:"The buyer has been notified." });
          logActivity("payment-reject", `Rejected order ${orderId}${reason ? " — " + reason : ""}`);
        }
        window.YF.ui.closeModal("orderActionModal");
      }catch(err){
        console.error("YF.admin: performOrderAction failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't complete action", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = action === "refund" ? "Refund Payment" : "Reject Payment";
      }
    }

    function bindPaymentsPage(){
      const tbody = document.getElementById("adminPaymentsTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const approveBtn = e.target.closest("[data-approve-order]");
          const rejectBtn = e.target.closest("[data-reject-order]");
          const refundBtn = e.target.closest("[data-refund-order]");
          const thumb = e.target.closest("[data-view-screenshot]");
          if (approveBtn) approvePayment(approveBtn.dataset.approveOrder);
          if (rejectBtn) openOrderAction(rejectBtn.dataset.rejectOrder, "reject");
          if (refundBtn) openOrderAction(refundBtn.dataset.refundOrder, "refund");
          if (thumb) window.open(thumb.dataset.viewScreenshot, "_blank", "noopener");
        });
        tbody.dataset.bound = "true";
      }
      const confirmBtn = document.getElementById("confirmOrderActionBtn");
      if (confirmBtn && confirmBtn.dataset.bound !== "true"){
        confirmBtn.addEventListener("click", performOrderAction);
        confirmBtn.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminPaymentSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { orderFilters.search = e.target.value; renderOrdersTable(); });
        searchInput.dataset.bound = "true";
      }
      const statusFilter = document.getElementById("adminPaymentStatusFilter");
      if (statusFilter && statusFilter.dataset.bound !== "true"){
        statusFilter.addEventListener("change", (e) => { orderFilters.status = e.target.value; renderOrdersTable(); });
        statusFilter.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-payments". */
    function renderPaymentsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindPaymentsPage();
      if (!ordersUnsub) subscribeOrders(); else renderOrdersTable();
    }

    /* ---------------------------------------------------------
       LICENSE MANAGEMENT (Phase F)
       Reads every license via YF.licenses.subscribeAllLicenses();
       actions delegate to YF.licenses' revoke/suspend/reactivate/
       renew/resetDeviceLock, each logged to activityLogs and (for
       revoke) notifying the buyer.
       --------------------------------------------------------- */
    let adminLicensesCache = [];
    let adminLicensesUnsub = null;
    const adminLicenseFilters = { status: "all", search: "" };

    function getFilteredAdminLicenses(){
      const q = adminLicenseFilters.search.trim().toLowerCase();
      const L = window.YF.licenses;
      return adminLicensesCache.filter(l => {
        if (adminLicenseFilters.status !== "all" && L.computeEffectiveStatus(l) !== adminLicenseFilters.status) return false;
        if (q && !`${l.licenseKey || ""} ${l.productTitle || ""}`.toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function renderAdminLicensesTable(){
      const tbody = document.getElementById("adminLicensesTableBody");
      if (!tbody) return;
      const L = window.YF.licenses;
      const list = getFilteredAdminLicenses();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="7"><div class="admin-empty-state">${adminLicensesCache.length ? "No licenses match this view." : "No licenses issued yet."}</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(l => {
        const status = L.computeEffectiveStatus(l);
        const meta = L.LICENSE_STATUS_META[status];
        const expiryMs = (l.expiryDate && l.expiryDate.toMillis) ? l.expiryDate.toMillis() : (l.expiryDate ? new Date(l.expiryDate).getTime() : 0);
        const actions = [];
        if (status === "revoked"){
          actions.push(`<span class="u-text-muted" style="font-size:var(--fs-xs);">No further actions</span>`);
        } else {
          if (status === "suspended") actions.push(`<button type="button" class="admin-action-btn admin-action-btn--success" data-license-action="reactivate" data-id="${l.id}">Reactivate</button>`);
          else actions.push(`<button type="button" class="admin-action-btn" data-license-action="suspend" data-id="${l.id}">Suspend</button>`);
          actions.push(`<button type="button" class="admin-action-btn" data-license-action="renew" data-id="${l.id}">Renew +365d</button>`);
          actions.push(`<button type="button" class="admin-action-btn admin-action-btn--danger" data-license-action="revoke" data-id="${l.id}">Revoke</button>`);
        }
        if (l.boundDeviceId) actions.push(`<button type="button" class="admin-action-btn" data-license-action="reset-device" data-id="${l.id}">Reset Device</button>`);
        return `
        <tr data-license-row="${l.id}">
          <td><code>${escapeHtml(l.licenseKey || l.id)}</code></td>
          <td class="u-text-muted">${escapeHtml(l.productTitle || "")}</td>
          <td>${l.downloadCount || 0} / ${l.downloadLimit || "∞"}</td>
          <td class="u-text-muted">${expiryMs ? new Date(expiryMs).toLocaleDateString() : "—"}</td>
          <td class="u-text-muted" style="font-size:var(--fs-xs);">${l.boundDeviceId ? "🔒 Locked" : "Unlocked"}</td>
          <td><span class="status-badge ${meta.badgeClass}">${escapeHtml(meta.label)}</span></td>
          <td><div class="admin-row-actions">${actions.join("")}</div></td>
        </tr>`;
      }).join("");
    }

    function subscribeAdminLicenses(){
      if (adminLicensesUnsub){ try{ adminLicensesUnsub(); }catch(e){} adminLicensesUnsub = null; }
      if (!(window.YF.licenses && window.YF.licenses.subscribeAllLicenses)){ adminLicensesCache = []; renderAdminLicensesTable(); return; }
      adminLicensesUnsub = window.YF.licenses.subscribeAllLicenses((list) => {
        adminLicensesCache = list;
        renderAdminLicensesTable();
      });
    }

    async function performLicenseAction(action, id){
      const L = window.YF.licenses;
      const license = adminLicensesCache.find(l => l.id === id);
      try{
        if (action === "revoke"){
          if (!confirm("Revoke this license permanently? The buyer will be notified and lose access to downloads.")) return;
          await L.revokeLicense(id);
          logActivity("license_revoke", `Revoked license ${license ? license.licenseKey : id}`);
          if (license && license.userId && window.YF.notifications){
            window.YF.notifications.create({ uid: license.userId, type:"danger", title:"License revoked", message:`Your license for "${license.productTitle || "a product"}" has been revoked.` });
          }
        } else if (action === "suspend"){
          await L.suspendLicense(id);
          logActivity("license_suspend", `Suspended license ${license ? license.licenseKey : id}`);
        } else if (action === "reactivate"){
          await L.reactivateLicense(id);
          logActivity("license_reactivate", `Reactivated license ${license ? license.licenseKey : id}`);
        } else if (action === "renew"){
          await L.renewLicense(id, 365);
          logActivity("license_renew", `Renewed license ${license ? license.licenseKey : id} by 365 days`);
          if (license && license.userId && window.YF.notifications){
            window.YF.notifications.create({ uid: license.userId, type:"success", title:"License renewed", message:`Your license for "${license.productTitle || "a product"}" was extended by 365 days.` });
          }
        } else if (action === "reset-device"){
          await L.resetDeviceLock(id);
          logActivity("license_reset_device", `Reset device lock on license ${license ? license.licenseKey : id}`);
        }
        window.YF.ui.toast({ type:"success", title:"Done" });
      }catch(err){
        window.YF.ui.toast({ type:"danger", title:"Couldn't complete action", message: err.message || "Please try again." });
      }
    }

    function bindAdminLicensesPage(){
      const tbody = document.getElementById("adminLicensesTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-license-action]");
          if (btn) performLicenseAction(btn.dataset.licenseAction, btn.dataset.id);
        });
        tbody.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminLicenseSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { adminLicenseFilters.search = e.target.value; renderAdminLicensesTable(); });
        searchInput.dataset.bound = "true";
      }
      const statusFilter = document.getElementById("adminLicenseStatusFilter");
      if (statusFilter && statusFilter.dataset.bound !== "true"){
        statusFilter.addEventListener("change", (e) => { adminLicenseFilters.status = e.target.value; renderAdminLicensesTable(); });
        statusFilter.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-licenses". */
    function renderAdminLicensesPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindAdminLicensesPage();
      if (!adminLicensesUnsub) subscribeAdminLicenses(); else renderAdminLicensesTable();
    }

    /* ---------------------------------------------------------
       WITHDRAWAL REQUESTS (Phase B)
       Reads the top-level "withdrawRequests" collection via
       YF.wallet.subscribeAllWithdrawals(); Approve/Reject delegate to
       YF.wallet.approveWithdrawal()/rejectWithdrawal(), which own the
       actual wallet-balance transaction logic.
       --------------------------------------------------------- */
    function updateWithdrawalsPendingBadge(){
      const badge = document.getElementById("adminWithdrawalsPendingBadge");
      if (!badge) return;
      const count = withdrawalsCache.filter(w => w.status === "pending").length;
      badge.textContent = String(count);
      badge.classList.toggle("u-hidden", count === 0);
    }

    function subscribeWithdrawals(){
      if (withdrawalsUnsub){ try{ withdrawalsUnsub(); }catch(e){} withdrawalsUnsub = null; }
      if (!(window.YF.wallet && window.YF.wallet.subscribeAllWithdrawals)){ withdrawalsCache = []; renderWithdrawalsTable(); return; }
      withdrawalsUnsub = window.YF.wallet.subscribeAllWithdrawals((list) => {
        withdrawalsCache = list.sort((a, b) => {
          const at = (a.requestedAt && a.requestedAt.toMillis) ? a.requestedAt.toMillis() : 0;
          const bt = (b.requestedAt && b.requestedAt.toMillis) ? b.requestedAt.toMillis() : 0;
          return bt - at;
        });
        updateWithdrawalsPendingBadge();
        renderWithdrawalsTable();
      });
    }

    function getFilteredWithdrawals(){
      const q = withdrawalFilters.search.trim().toLowerCase();
      return withdrawalsCache.filter(w => {
        if (withdrawalFilters.status !== "all" && (w.status || "pending") !== withdrawalFilters.status) return false;
        if (q && !String(w.userEmail || "").toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function renderWithdrawalsTable(){
      const tbody = document.getElementById("adminWithdrawalsTableBody");
      if (!tbody) return;
      const list = getFilteredWithdrawals();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="7"><div class="admin-empty-state">${withdrawalsCache.length ? "No requests match this view." : "No withdrawal requests yet."}</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(w => {
        const ms = (w.requestedAt && w.requestedAt.toMillis) ? w.requestedAt.toMillis() : 0;
        const actions = w.status === "pending"
          ? `<button type="button" class="admin-action-btn admin-action-btn--success" data-approve-withdrawal="${w.id}">Approve</button>
             <button type="button" class="admin-action-btn admin-action-btn--danger" data-reject-withdrawal="${w.id}">Reject</button>`
          : `<span class="u-text-muted" style="font-size:var(--fs-xs);">${escapeHtml(w.adminNote || "")}</span>`;
        return `
        <tr data-withdrawal-row="${w.id}">
          <td class="u-text-muted">${escapeHtml(w.userEmail || w.uid)}</td>
          <td>${formatPrice(w.amount)}</td>
          <td>${escapeHtml(w.methodLabel || w.methodId)}</td>
          <td class="u-text-muted" style="max-width:220px; word-break:break-word;">${escapeHtml(w.accountDetails || "")}</td>
          <td><span class="status-badge status-badge--${w.status}">${escapeHtml(w.status)}</span></td>
          <td class="u-text-muted">${ms ? new Date(ms).toLocaleDateString() : "—"}</td>
          <td><div class="admin-row-actions">${actions}</div></td>
        </tr>`;
      }).join("");
    }

    async function approveWithdrawalAction(id){
      try{
        await window.YF.wallet.approveWithdrawal(id);
        window.YF.ui.toast({ type:"success", title:"Withdrawal approved", message:"Marked as paid out." });
      }catch(err){
        window.YF.ui.toast({ type:"danger", title:"Couldn't approve", message: err.message || "Please try again." });
      }
    }

    async function rejectWithdrawalAction(id){
      const reason = window.prompt("Reason for rejecting this withdrawal? (the held amount will be refunded to the user's wallet)") || "";
      try{
        await window.YF.wallet.rejectWithdrawal(id, reason);
        window.YF.ui.toast({ type:"success", title:"Withdrawal rejected", message:"The amount was refunded to the user's wallet." });
      }catch(err){
        window.YF.ui.toast({ type:"danger", title:"Couldn't reject", message: err.message || "Please try again." });
      }
    }

    function bindWithdrawalsPage(){
      const tbody = document.getElementById("adminWithdrawalsTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const approveBtn = e.target.closest("[data-approve-withdrawal]");
          const rejectBtn = e.target.closest("[data-reject-withdrawal]");
          if (approveBtn) approveWithdrawalAction(approveBtn.dataset.approveWithdrawal);
          if (rejectBtn) rejectWithdrawalAction(rejectBtn.dataset.rejectWithdrawal);
        });
        tbody.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminWithdrawalSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { withdrawalFilters.search = e.target.value; renderWithdrawalsTable(); });
        searchInput.dataset.bound = "true";
      }
      const statusFilter = document.getElementById("adminWithdrawalStatusFilter");
      if (statusFilter && statusFilter.dataset.bound !== "true"){
        statusFilter.addEventListener("change", (e) => { withdrawalFilters.status = e.target.value; renderWithdrawalsTable(); });
        statusFilter.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-withdrawals". */
    function renderWithdrawalsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindWithdrawalsPage();
      if (!withdrawalsUnsub) subscribeWithdrawals(); else renderWithdrawalsTable();
    }

    /* ---------------------------------------------------------
       EARNINGS DASHBOARD (Phase B)
       Reads the SAME "orders" collection as the Payment Approval
       Queue and Admin Dashboard, plus every wallets/{uid} doc for
       Withdrawable Balance. All read-only aggregation — no writes.
       --------------------------------------------------------- */
    function renderEarningsChart(orders){
      const chart = document.getElementById("earningsMonthlyChart");
      if (!chart) return;
      const now = new Date();
      const buckets = [];
      for (let i = 5; i >= 0; i--){
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        buckets.push({ year: d.getFullYear(), month: d.getMonth(), total: 0, label: d.toLocaleDateString(undefined, { month: "short" }) });
      }
      orders.filter(o => o.status === "approved").forEach(o => {
        const ms = (o.createdAt && o.createdAt.toMillis) ? o.createdAt.toMillis() : 0;
        if (!ms) return;
        const d = new Date(ms);
        const bucket = buckets.find(b => b.year === d.getFullYear() && b.month === d.getMonth());
        if (bucket) bucket.total += Number(o.amount) || 0;
      });
      const max = Math.max(1, ...buckets.map(b => b.total));
      chart.innerHTML = buckets.map(b => `
        <div class="admin-bar-chart__col">
          <div class="admin-bar-chart__bar" data-value="${formatMoney(b.total)}" style="height:${Math.max(4, Math.round((b.total / max) * 100))}%;"></div>
          <div class="admin-bar-chart__label">${b.label}</div>
        </div>
      `).join("");
    }

    /** Entry point wired from handleRouteClick for data-route="admin-earnings". */
    async function renderEarningsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      const fb = window.YF.firebase;
      if (!(fb && fb.db)) return;
      try{
        const ordersSnap = await fb.getDocs(fb.collection(fb.db, "orders"));
        const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const approved = orders.filter(o => o.status === "approved");
        const pending  = orders.filter(o => o.status === "pending");
        const refunded = orders.filter(o => o.status === "refunded");
        const totalRevenue = approved.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
        const pendingRevenue = pending.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
        const now = new Date();
        const monthlyRevenue = approved.filter(o => {
          const ms = (o.createdAt && o.createdAt.toMillis) ? o.createdAt.toMillis() : 0;
          if (!ms) return false;
          const d = new Date(ms);
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        }).reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

        // Withdrawable Balance = sum of every user's current wallet
        // balance (funds already held for pending withdrawals are
        // already excluded, since requestWithdraw() debits on request).
        let withdrawable = 0;
        try{
          const walletsSnap = await fb.getDocs(fb.collection(fb.db, "wallets"));
          withdrawable = walletsSnap.docs.reduce((sum, d) => sum + (Number(d.data().balance) || 0), 0);
        }catch(err){ console.error("YF.admin: wallets aggregate read failed", err); }

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set("earnStatTotalRevenue", formatMoney(totalRevenue));
        set("earnStatMonthlyRevenue", formatMoney(monthlyRevenue));
        set("earnStatPendingRevenue", formatMoney(pendingRevenue));
        set("earnStatWithdrawable", formatMoney(withdrawable));
        set("earnStatApprovedCount", approved.length.toLocaleString());
        set("earnStatPendingCount", pending.length.toLocaleString());
        set("earnStatRefundedCount", refunded.length.toLocaleString());

        renderEarningsChart(orders);
      }catch(err){
        console.error("YF.admin: renderEarningsPage failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't load earnings", message:"Some stats failed to load." });
      }
    }

    /* ---------------------------------------------------------
       AFFILIATES (Phase C)
       Reads the "affiliates" collection via
       YF.affiliate.subscribeAllAffiliates(); commission % and
       suspend/activate delegate to YF.affiliate.adminSetCommission()/
       adminSetStatus(). Emails are resolved against the SAME
       usersCache the User Management page already maintains, rather
       than duplicating a user lookup.
       --------------------------------------------------------- */
    let affiliatesCache = [];
    let affiliatesUnsub = null;
    let affiliateSearch = "";

    // SECTION 23j — added: commission ledger (affiliateSales) state
    let commissionsCache = [];
    let commissionsUnsub = null;
    let commissionFilter = "all";

    function getUserEmail(uid){
      const u = usersCache.find(x => x.uid === uid);
      return u ? (u.email || u.name || uid) : uid;
    }

    function subscribeAffiliates(){
      if (affiliatesUnsub){ try{ affiliatesUnsub(); }catch(e){} affiliatesUnsub = null; }
      if (!(window.YF.affiliate && window.YF.affiliate.subscribeAllAffiliates)){ affiliatesCache = []; renderAffiliatesTable(); return; }
      affiliatesUnsub = window.YF.affiliate.subscribeAllAffiliates((list) => {
        affiliatesCache = list;
        renderAffiliatesTable();
        renderAffiliateStats();
        renderTopAffiliates();
      });
    }

    function subscribeCommissions(){
      if (commissionsUnsub){ try{ commissionsUnsub(); }catch(e){} commissionsUnsub = null; }
      if (!(window.YF.affiliate && window.YF.affiliate.subscribeAllSales)){ commissionsCache = []; renderCommissionsTable(); return; }
      commissionsUnsub = window.YF.affiliate.subscribeAllSales((list) => {
        commissionsCache = list.sort((a, b) => {
          const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
          const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
          return bt - at;
        });
        renderCommissionsTable();
        renderAffiliateStats();
      });
    }

    /** SECTION 23j — added. Stat cards: Total Affiliates, Total
     *  Referrals (= total conversions across every affiliate), and
     *  Pending/Approved/Paid commission counts + total $ — all
     *  computed client-side from the two caches above, no extra
     *  Firestore reads. */
    function renderAffiliateStats(){
      const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setText("affStatTotalAffiliates", affiliatesCache.length.toLocaleString());
      const totalReferrals = affiliatesCache.reduce((sum, a) => sum + (Number(a.totalConversions) || 0), 0);
      setText("affStatTotalReferrals", totalReferrals.toLocaleString());
      const approved = commissionsCache.filter(c => c.status === "approved");
      const paid = commissionsCache.filter(c => c.status === "paid");
      setText("affStatPending", "0"); // this system credits on order-approval directly — nothing sits "pending" between order-approve and commission-approve, they're the same action
      setText("affStatApproved", `${approved.length} (${formatMoney(approved.reduce((s, c) => s + (Number(c.commissionAmount) || 0), 0))})`);
      setText("affStatPaid", `${paid.length} (${formatMoney(paid.reduce((s, c) => s + (Number(c.commissionAmount) || 0), 0))})`);
      const totalAmount = commissionsCache.reduce((s, c) => s + (c.status !== "rejected" ? (Number(c.commissionAmount) || 0) : 0), 0);
      setText("affStatTotalAmount", formatMoney(totalAmount));
    }

    function renderTopAffiliates(){
      const el = document.getElementById("affTopAffiliatesList");
      if (!el) return;
      const top = [...affiliatesCache].sort((a, b) => (Number(b.totalEarnings) || 0) - (Number(a.totalEarnings) || 0)).slice(0, 5);
      if (!top.length){ el.innerHTML = `<p class="u-text-muted">No affiliates yet.</p>`; return; }
      el.innerHTML = top.map((a, i) => `
        <div class="payment-details__row u-mb-2">
          <div><div class="payment-details__row-label">#${i + 1} — ${escapeHtml(getUserEmail(a.uid))}</div><div class="u-text-muted" style="font-size:var(--fs-xs);">${a.totalConversions || 0} referrals</div></div>
          <div class="payment-details__row-value">${formatMoney(a.totalEarnings || 0)}</div>
        </div>`).join("");
    }

    function commissionStatusBadge(status){
      const meta = {
        approved: { label: "Approved", cls: "status-badge--approved" },
        paid:     { label: "Paid",     cls: "status-badge--approved" },
        rejected: { label: "Rejected", cls: "status-badge--rejected" }
      }[status] || { label: status || "Unknown", cls: "status-badge--pending" };
      return `<span class="status-badge ${meta.cls}">${escapeHtml(meta.label)}</span>`;
    }

    function renderCommissionsTable(){
      const tbody = document.getElementById("adminCommissionsTableBody");
      if (!tbody) return;
      const list = commissionFilter === "all" ? commissionsCache : commissionsCache.filter(c => c.status === commissionFilter);
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="7"><div class="admin-empty-state">No commission records match this view.</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(c => {
        const ms = (c.createdAt && c.createdAt.toMillis) ? c.createdAt.toMillis() : 0;
        const actions = c.status === "approved"
          ? `<div class="admin-row-actions">
              <button type="button" class="admin-action-btn admin-action-btn--success" data-mark-paid="${c.id}">Mark Paid</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-reject-commission="${c.id}">Reject</button>
            </div>`
          : `<span class="u-text-muted">—</span>`;
        return `
        <tr data-commission-row="${c.id}">
          <td class="u-text-muted">${escapeHtml(getUserEmail(c.affiliateUid))}</td>
          <td class="u-text-muted">${escapeHtml(c.productTitle || c.productId || "—")}${c.isBundle ? ` <span class="u-text-muted" style="font-size:var(--fs-xs);">(bundle)</span>` : ""}</td>
          <td>${formatMoney(c.orderAmount || 0)}</td>
          <td class="order-amount">${formatMoney(c.commissionAmount || 0)}</td>
          <td>${commissionStatusBadge(c.status)}</td>
          <td class="u-text-muted">${ms ? new Date(ms).toLocaleDateString() : "—"}</td>
          <td>${actions}</td>
        </tr>`;
      }).join("");
    }

    function renderAffiliatesTable(){
      const tbody = document.getElementById("adminAffiliatesTableBody");
      if (!tbody) return;
      const q = affiliateSearch.trim().toLowerCase();
      const list = affiliatesCache.filter(a => {
        if (!q) return true;
        return getUserEmail(a.uid).toLowerCase().includes(q) || String(a.code || "").toLowerCase().includes(q);
      });
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="7"><div class="admin-empty-state">${affiliatesCache.length ? "No affiliates match this search." : "No affiliates enrolled yet."}</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(a => `
        <tr data-affiliate-row="${a.uid}">
          <td class="u-text-muted">${escapeHtml(getUserEmail(a.uid))}</td>
          <td><code>${escapeHtml(a.code || "")}</code></td>
          <td>
            <input type="number" class="form-input" style="max-width:90px;" min="0" max="100" step="0.5"
              value="${Number(a.commissionPercent) || 0}" data-commission-input="${a.uid}">
          </td>
          <td>${(a.totalConversions || 0).toLocaleString()}</td>
          <td>${formatMoney(a.totalEarnings || 0)}</td>
          <td><span class="status-badge status-badge--${a.status === "suspended" ? "suspended" : "approved"}">${escapeHtml(a.status || "active")}</span></td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-save-commission="${a.uid}">Save %</button>
              <button type="button" class="admin-action-btn ${a.status === "suspended" ? "admin-action-btn--success" : "admin-action-btn--danger"}" data-toggle-affiliate-status="${a.uid}" data-current-status="${a.status || "active"}">${a.status === "suspended" ? "Activate" : "Suspend"}</button>
            </div>
          </td>
        </tr>`).join("");
    }

    function bindAffiliatesPage(){
      const tbody = document.getElementById("adminAffiliatesTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", async (e) => {
          const saveBtn = e.target.closest("[data-save-commission]");
          const toggleBtn = e.target.closest("[data-toggle-affiliate-status]");
          if (saveBtn){
            const uid = saveBtn.dataset.saveCommission;
            const input = tbody.querySelector(`[data-commission-input="${uid}"]`);
            try{
              await window.YF.affiliate.adminSetCommission(uid, input.value);
              window.YF.ui.toast({ type:"success", title:"Commission updated" });
            }catch(err){
              window.YF.ui.toast({ type:"danger", title:"Couldn't update commission", message: err.message || "Please try again." });
            }
          }
          if (toggleBtn){
            const uid = toggleBtn.dataset.toggleAffiliateStatus;
            const newStatus = toggleBtn.dataset.currentStatus === "suspended" ? "active" : "suspended";
            try{
              await window.YF.affiliate.adminSetStatus(uid, newStatus);
              window.YF.ui.toast({ type:"success", title: newStatus === "suspended" ? "Affiliate suspended" : "Affiliate activated" });
            }catch(err){
              window.YF.ui.toast({ type:"danger", title:"Couldn't update status", message: err.message || "Please try again." });
            }
          }
        });
        tbody.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminAffiliateSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { affiliateSearch = e.target.value; renderAffiliatesTable(); });
        searchInput.dataset.bound = "true";
      }
      // SECTION 23j — added: commission ledger actions + status tabs
      const commTbody = document.getElementById("adminCommissionsTableBody");
      if (commTbody && commTbody.dataset.bound !== "true"){
        commTbody.addEventListener("click", async (e) => {
          const payBtn = e.target.closest("[data-mark-paid]");
          const rejBtn = e.target.closest("[data-reject-commission]");
          if (payBtn){
            const id = payBtn.dataset.markPaid;
            payBtn.disabled = true; payBtn.textContent = "Marking…";
            try{
              await window.YF.affiliate.adminMarkCommissionPaid(id);
              window.YF.ui.toast({ type:"success", title:"Marked as paid", message:"The affiliate's balance has been debited accordingly." });
              logActivity("affiliate-commission-paid", `Marked commission ${id} as paid`);
            }catch(err){
              console.error("YF.admin: mark commission paid failed", err);
              window.YF.ui.toast({ type:"danger", title:"Couldn't mark as paid", message: err.message || "Please try again." });
              payBtn.disabled = false; payBtn.textContent = "Mark Paid";
            }
          }
          if (rejBtn){
            if (!confirm("Reject this commission? It will be deducted from the affiliate's wallet balance.")) return;
            const id = rejBtn.dataset.rejectCommission;
            rejBtn.disabled = true; rejBtn.textContent = "Rejecting…";
            try{
              await window.YF.affiliate.adminRejectCommission(id);
              window.YF.ui.toast({ type:"info", title:"Commission rejected", message:"The affiliate's balance has been adjusted." });
              logActivity("affiliate-commission-rejected", `Rejected commission ${id}`);
            }catch(err){
              console.error("YF.admin: reject commission failed", err);
              window.YF.ui.toast({ type:"danger", title:"Couldn't reject commission", message: err.message || "Please try again." });
              rejBtn.disabled = false; rejBtn.textContent = "Reject";
            }
          }
        });
        commTbody.dataset.bound = "true";
      }
      const commTabs = document.getElementById("affCommissionStatusTabs");
      if (commTabs && commTabs.dataset.bound !== "true"){
        commTabs.dataset.bound = "true";
        commTabs.querySelectorAll("[data-comm-filter]").forEach(tabBtn => {
          tabBtn.addEventListener("click", () => {
            commissionFilter = tabBtn.dataset.commFilter;
            commTabs.querySelectorAll("[data-comm-filter]").forEach(b => b.classList.toggle("is-active", b === tabBtn));
            renderCommissionsTable();
          });
        });
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-affiliates". */
    function renderAffiliatesPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      ensureUsersLoaded();
      bindAffiliatesPage();
      if (!affiliatesUnsub) subscribeAffiliates(); else { renderAffiliatesTable(); renderAffiliateStats(); renderTopAffiliates(); }
      if (!commissionsUnsub) subscribeCommissions(); else renderCommissionsTable();
    }

    /* ---------------------------------------------------------
       SALES ANALYTICS (Phase C)
       Aggregates the "orders" collection client-side into a
       period-toggleable revenue graph plus Top Products / Top
       Categories / Top Customers. Categories are resolved against
       window.YF.marketplace.getAllProducts() rather than duplicating
       a product read here.
       --------------------------------------------------------- */
    function bucketOrdersByPeriod(orders, period){
      const now = new Date();
      const buckets = [];
      if (period === "daily"){
        for (let i = 13; i >= 0; i--){
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          buckets.push({ match: (od) => od.getFullYear() === d.getFullYear() && od.getMonth() === d.getMonth() && od.getDate() === d.getDate(), total: 0, label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) });
        }
      } else if (period === "weekly"){
        for (let i = 7; i >= 0; i--){
          const start = new Date(now); start.setDate(now.getDate() - now.getDay() - i * 7); start.setHours(0,0,0,0);
          const end = new Date(start); end.setDate(start.getDate() + 7);
          buckets.push({ match: (od) => od >= start && od < end, total: 0, label: start.toLocaleDateString(undefined, { day: "numeric", month: "short" }) });
        }
      } else if (period === "yearly"){
        for (let i = 4; i >= 0; i--){
          const y = now.getFullYear() - i;
          buckets.push({ match: (od) => od.getFullYear() === y, total: 0, label: String(y) });
        }
      } else { // monthly
        for (let i = 11; i >= 0; i--){
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          buckets.push({ match: (od) => od.getFullYear() === d.getFullYear() && od.getMonth() === d.getMonth(), total: 0, label: d.toLocaleDateString(undefined, { month: "short" }) });
        }
      }
      orders.forEach(o => {
        const ms = (o.createdAt && o.createdAt.toMillis) ? o.createdAt.toMillis() : 0;
        if (!ms) return;
        const od = new Date(ms);
        const bucket = buckets.find(b => b.match(od));
        if (bucket) bucket.total += Number(o.amount) || 0;
      });
      return buckets;
    }

    function renderAnalyticsRevenueChart(orders, period){
      const chart = document.getElementById("analyticsRevenueChart");
      if (!chart) return;
      const buckets = bucketOrdersByPeriod(orders.filter(o => o.status === "approved"), period);
      const max = Math.max(1, ...buckets.map(b => b.total));
      chart.innerHTML = buckets.map(b => `
        <div class="admin-bar-chart__col">
          <div class="admin-bar-chart__bar" data-value="${formatMoney(b.total)}" style="height:${Math.max(4, Math.round((b.total / max) * 100))}%;"></div>
          <div class="admin-bar-chart__label">${b.label}</div>
        </div>
      `).join("");
    }

    function renderTopList(elId, rows, emptyMsg){
      const el = document.getElementById(elId);
      if (!el) return;
      if (!rows.length){ el.innerHTML = `<p class="u-text-muted">${emptyMsg}</p>`; return; }
      const max = Math.max(...rows.map(r => r.total), 1);
      el.innerHTML = rows.map((r, i) => `
        <div class="u-mb-4">
          <div class="payment-details__row">
            <div><div class="payment-details__row-label">#${i + 1} — ${escapeHtml(r.label)}</div><div class="u-text-muted" style="font-size:var(--fs-xs);">${r.count} order${r.count === 1 ? "" : "s"}</div></div>
            <div class="payment-details__row-value">${formatMoney(r.total)}</div>
          </div>
          <div style="height:6px; background:var(--glass-bg-strong); border-radius:var(--r-full); margin-top:6px; overflow:hidden;">
            <div style="height:100%; width:${Math.max(3, Math.round((r.total / max) * 100))}%; background:linear-gradient(90deg, var(--c-gold-600), var(--c-gold-300)); border-radius:var(--r-full);"></div>
          </div>
        </div>`).join("");
    }

    let analyticsOrdersCache = [];
    let analyticsPeriod = "monthly";

    let analyticsCategoryPieChart = null;

    /** SECTION 23l — added. Real Chart.js pie chart (the app's first)
     *  showing revenue share by category — same byCategory data
     *  renderTopList already uses, just visualized differently.
     *  Rebuilds (rather than .update()s) on every call since the
     *  category set itself can change between renders — simplest
     *  correct approach for a chart that re-renders on every
     *  Firestore snapshot. */
    function renderAnalyticsCategoryPie(byCategory){
      const canvas = document.getElementById("analyticsCategoryPieChart");
      if (!canvas || typeof Chart === "undefined") return;
      const entries = Object.values(byCategory).sort((a, b) => b.total - a.total).slice(0, 6);
      if (analyticsCategoryPieChart){ analyticsCategoryPieChart.destroy(); analyticsCategoryPieChart = null; }
      if (!entries.length) return;
      const palette = ["#d4af37", "#e9c877", "#b8912b", "#8f6f1f", "#f6e7c1", "#6b5316"];
      analyticsCategoryPieChart = new Chart(canvas.getContext("2d"), {
        type: "pie",
        data: {
          labels: entries.map(e => categoryLabel ? categoryLabel(e.label) : e.label),
          datasets: [{ data: entries.map(e => e.total), backgroundColor: palette, borderWidth: 0 }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { position: "bottom", labels: { color: "#a89f8c", font: { size: 11 }, boxWidth:10, padding:8 } },
            tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${formatMoney(ctx.parsed)}` } }
          }
        }
      });
    }

    function renderAnalyticsAll(){
      const approved = analyticsOrdersCache.filter(o => o.status === "approved");

      renderAnalyticsRevenueChart(analyticsOrdersCache, analyticsPeriod);

      const byProduct = {};
      approved.forEach(o => {
        const key = o.productId || o.productTitle || "unknown";
        if (!byProduct[key]) byProduct[key] = { label: o.productTitle || "Product", total: 0, count: 0 };
        byProduct[key].total += Number(o.amount) || 0;
        byProduct[key].count += 1;
      });
      renderTopList("analyticsTopProducts", Object.values(byProduct).sort((a, b) => b.total - a.total).slice(0, 5), "No sales yet.");

      const allProducts = (window.YF.marketplace && window.YF.marketplace.getAllProducts()) || [];
      const byCategory = {};
      approved.forEach(o => {
        const product = allProducts.find(p => p.id === o.productId);
        const key = product ? product.category : "unknown";
        if (!byCategory[key]) byCategory[key] = { label: key, total: 0, count: 0 };
        byCategory[key].total += Number(o.amount) || 0;
        byCategory[key].count += 1;
      });
      renderTopList("analyticsTopCategories", Object.values(byCategory).sort((a, b) => b.total - a.total).slice(0, 5), "No sales yet.");
      renderAnalyticsCategoryPie(byCategory); // SECTION 23l — added

      const byCustomer = {};
      approved.forEach(o => {
        const key = o.uid || o.buyerEmail || "unknown";
        if (!byCustomer[key]) byCustomer[key] = { label: o.buyerEmail || o.buyerName || "Customer", total: 0, count: 0 };
        byCustomer[key].total += Number(o.amount) || 0;
        byCustomer[key].count += 1;
      });
      renderTopList("analyticsTopCustomers", Object.values(byCustomer).sort((a, b) => b.total - a.total).slice(0, 5), "No sales yet.");
    }

    let analyticsUnsub = null;
    function bindAnalyticsPage(){
      const select = document.getElementById("analyticsPeriodSelect");
      if (select && select.dataset.bound !== "true"){
        select.addEventListener("change", (e) => { analyticsPeriod = e.target.value; renderAnalyticsAll(); });
        select.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-analytics". */
    function renderAnalyticsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindAnalyticsPage();
      const fb = window.YF.firebase;
      if (!(fb && fb.db)) return;
      if (analyticsUnsub){ try{ analyticsUnsub(); }catch(e){} }
      analyticsUnsub = fb.onSnapshot(fb.collection(fb.db, "orders"), (snap) => {
        analyticsOrdersCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderAnalyticsAll();
      }, (err) => { console.error("YF.admin: analytics onSnapshot failed", err); });
    }

    /* ---------------------------------------------------------
       ADMIN SUPPORT TICKETS (Phase D)
       Reads every ticket via YF.tickets.subscribeAllTickets();
       replies/status/priority delegate to YF.tickets.adminReply()/
       updateStatus()/updatePriority().
       --------------------------------------------------------- */
    let adminTicketsCache = [];
    let adminTicketsUnsub = null;
    let activeAdminTicketId = null;
    const adminTicketFilters = { status: "all", priority: "all", search: "" };

    function updateTicketsPendingBadge(){
      const badge = document.getElementById("adminTicketsPendingBadge");
      if (!badge) return;
      const count = adminTicketsCache.filter(t => t.status === "open").length;
      badge.textContent = String(count);
      badge.classList.toggle("u-hidden", count === 0);
    }

    function subscribeAdminTickets(){
      if (adminTicketsUnsub){ try{ adminTicketsUnsub(); }catch(e){} adminTicketsUnsub = null; }
      if (!(window.YF.tickets && window.YF.tickets.subscribeAllTickets)){ adminTicketsCache = []; renderAdminTicketsTable(); return; }
      adminTicketsUnsub = window.YF.tickets.subscribeAllTickets((list) => {
        adminTicketsCache = list.sort((a, b) => {
          const at = (a.updatedAt && a.updatedAt.toMillis) ? a.updatedAt.toMillis() : 0;
          const bt = (b.updatedAt && b.updatedAt.toMillis) ? b.updatedAt.toMillis() : 0;
          return bt - at;
        });
        updateTicketsPendingBadge();
        renderAdminTicketsTable();
      });
    }

    function getFilteredAdminTickets(){
      const q = adminTicketFilters.search.trim().toLowerCase();
      return adminTicketsCache.filter(t => {
        if (adminTicketFilters.status !== "all" && (t.status || "open") !== adminTicketFilters.status) return false;
        if (adminTicketFilters.priority !== "all" && (t.priority || "medium") !== adminTicketFilters.priority) return false;
        if (q && !`${t.subject || ""} ${t.userEmail || ""} ${t.userName || ""}`.toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function renderAdminTicketsTable(){
      const tbody = document.getElementById("adminTicketsTableBody");
      if (!tbody) return;
      const list = getFilteredAdminTickets();
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="6"><div class="admin-empty-state">${adminTicketsCache.length ? "No tickets match this view." : "No tickets yet."}</div></td></tr>`;
        return;
      }
      const T = window.YF.tickets;
      tbody.innerHTML = list.map(t => {
        const statusMeta = T.STATUS_META[t.status] || T.STATUS_META.open;
        const priorityMeta = T.PRIORITY_META[t.priority] || T.PRIORITY_META.medium;
        const ms = (t.updatedAt && t.updatedAt.toMillis) ? t.updatedAt.toMillis() : 0;
        return `
        <tr data-admin-ticket-row="${t.id}">
          <td class="u-text-muted">${escapeHtml(t.userEmail || t.userName || t.uid)}</td>
          <td>${escapeHtml(t.subject || "")}</td>
          <td><span class="status-badge ${priorityMeta.badgeClass}">${escapeHtml(priorityMeta.label)}</span></td>
          <td><span class="status-badge ${statusMeta.badgeClass}">${escapeHtml(statusMeta.label)}</span></td>
          <td class="u-text-muted">${ms ? new Date(ms).toLocaleDateString() : "—"}</td>
          <td><button type="button" class="admin-action-btn" data-open-admin-ticket="${t.id}">Open</button></td>
        </tr>`;
      }).join("");
    }

    function adminTicketMessageHTML(m){
      const ms = (m.createdAt && m.createdAt.toMillis) ? m.createdAt.toMillis() : 0;
      const mine = m.senderType === "admin";
      const attachment = m.attachmentURL
        ? (m.attachmentType && m.attachmentType.startsWith("image/")
            ? `<a href="${escapeHtml(m.attachmentURL)}" target="_blank" rel="noopener"><img src="${escapeHtml(m.attachmentURL)}" alt="Attachment" style="max-width:180px; border-radius:var(--r-sm); margin-top:6px; display:block;"></a>`
            : `<a href="${escapeHtml(m.attachmentURL)}" target="_blank" rel="noopener" style="display:inline-block; margin-top:6px; font-size:var(--fs-xs); color:var(--c-gold-300);">📎 View attachment</a>`)
        : "";
      return `
        <div class="ticket-message ${mine ? "ticket-message--user" : "ticket-message--support"}">
          <div class="ticket-message__bubble">${escapeHtml(m.message || "")}${attachment}</div>
          <div class="ticket-message__meta">${escapeHtml(m.senderName || (mine ? "Support" : "User"))} · ${ms ? new Date(ms).toLocaleString() : ""}</div>
        </div>`;
    }

    function openAdminTicketThread(ticketId){
      const t = adminTicketsCache.find(x => x.id === ticketId);
      if (!t) return;
      activeAdminTicketId = ticketId;
      const T = window.YF.tickets;
      document.getElementById("adminTicketThreadModalTitle").textContent = t.subject || "Ticket";
      const statusMeta = T.STATUS_META[t.status] || T.STATUS_META.open;
      const priorityMeta = T.PRIORITY_META[t.priority] || T.PRIORITY_META.medium;
      const statusBadge = document.getElementById("adminTicketThreadStatusBadge");
      statusBadge.className = `status-badge ${statusMeta.badgeClass}`;
      statusBadge.textContent = statusMeta.label;
      const priorityBadge = document.getElementById("adminTicketThreadPriorityBadge");
      priorityBadge.className = `status-badge ${priorityMeta.badgeClass}`;
      priorityBadge.textContent = priorityMeta.label;
      document.getElementById("adminTicketStatusSelect").value = t.status || "open";
      document.getElementById("adminTicketPrioritySelect").value = t.priority || "medium";
      const threadEl = document.getElementById("adminTicketThreadMessages");
      threadEl.innerHTML = `<div class="skeleton skeleton--text w-60"></div>`;
      window.YF.ui.openModal("adminTicketThreadModal");
      T.subscribeToMessages(ticketId, (messages) => {
        threadEl.innerHTML = messages.length ? messages.map(adminTicketMessageHTML).join("") : `<p class="u-text-muted">No messages yet.</p>`;
        threadEl.scrollTop = threadEl.scrollHeight;
      });
    }

    function bindAdminTicketsPage(){
      const tbody = document.getElementById("adminTicketsTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-open-admin-ticket]");
          if (btn) openAdminTicketThread(btn.dataset.openAdminTicket);
        });
        tbody.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminTicketSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { adminTicketFilters.search = e.target.value; renderAdminTicketsTable(); });
        searchInput.dataset.bound = "true";
      }
      const statusFilter = document.getElementById("adminTicketStatusFilter");
      if (statusFilter && statusFilter.dataset.bound !== "true"){
        statusFilter.addEventListener("change", (e) => { adminTicketFilters.status = e.target.value; renderAdminTicketsTable(); });
        statusFilter.dataset.bound = "true";
      }
      const priorityFilter = document.getElementById("adminTicketPriorityFilter");
      if (priorityFilter && priorityFilter.dataset.bound !== "true"){
        priorityFilter.addEventListener("change", (e) => { adminTicketFilters.priority = e.target.value; renderAdminTicketsTable(); });
        priorityFilter.dataset.bound = "true";
      }
      const statusSelect = document.getElementById("adminTicketStatusSelect");
      if (statusSelect && statusSelect.dataset.bound !== "true"){
        statusSelect.addEventListener("change", async (e) => {
          if (!activeAdminTicketId) return;
          try{ await window.YF.tickets.updateStatus(activeAdminTicketId, e.target.value); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't update status", message: err.message || "Please try again." }); }
        });
        statusSelect.dataset.bound = "true";
      }
      const prioritySelect = document.getElementById("adminTicketPrioritySelect");
      if (prioritySelect && prioritySelect.dataset.bound !== "true"){
        prioritySelect.addEventListener("change", async (e) => {
          if (!activeAdminTicketId) return;
          try{ await window.YF.tickets.updatePriority(activeAdminTicketId, e.target.value); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't update priority", message: err.message || "Please try again." }); }
        });
        prioritySelect.dataset.bound = "true";
      }
      const replyForm = document.getElementById("adminTicketReplyForm");
      if (replyForm && replyForm.dataset.bound !== "true"){
        replyForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const input = document.getElementById("adminTicketReplyInput");
          const attachmentInput = document.getElementById("adminTicketReplyAttachment");
          const attachmentFile = attachmentInput && attachmentInput.files ? attachmentInput.files[0] : null;
          if (!activeAdminTicketId || (!input.value.trim() && !attachmentFile)) return;
          const btn = document.getElementById("adminTicketReplyBtn");
          btn.disabled = true;
          try{
            await window.YF.tickets.adminReply(activeAdminTicketId, input.value, attachmentFile);
            input.value = "";
            if (attachmentInput) attachmentInput.value = "";
          }catch(err){
            window.YF.ui.toast({ type:"danger", title:"Couldn't send reply", message: err.message || "Please try again." });
          }finally{
            btn.disabled = false;
          }
        });
        replyForm.dataset.bound = "true";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-tickets". */
    function renderAdminTicketsPage(){
      if (!canManage('admin-tickets')){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindAdminTicketsPage();
      if (!adminTicketsUnsub) subscribeAdminTickets(); else renderAdminTicketsTable();
    }

    /* ---------------------------------------------------------
       ADMIN LIVE CHAT (Phase D)
       Reads every chat thread via YF.chat.subscribeAllThreads();
       selecting one loads its messages via
       YF.chat.subscribeToThreadMessages(uid). Replies/typing/read
       delegate to YF.chat.adminSendMessage()/adminSetTyping()/
       adminMarkRead().
       --------------------------------------------------------- */
    let adminChatThreadsCache = [];
    let adminChatThreadsUnsub = null;
    let adminChatMessagesUnsub = null;
    let activeAdminChatUid = null;

    function updateChatPendingBadge(){
      const badge = document.getElementById("adminChatPendingBadge");
      if (!badge) return;
      const count = adminChatThreadsCache.filter(c => c.unreadByAdmin).length;
      badge.textContent = String(count);
      badge.classList.toggle("u-hidden", count === 0);
    }

    function renderAdminChatThreadList(){
      const el = document.getElementById("adminChatThreadList");
      if (!el) return;
      if (!adminChatThreadsCache.length){ el.innerHTML = `<p class="u-text-muted" style="padding:var(--sp-3);">No conversations yet.</p>`; return; }
      el.innerHTML = adminChatThreadsCache.map(c => {
        const ms = (c.lastMessageAt && c.lastMessageAt.toMillis) ? c.lastMessageAt.toMillis() : 0;
        const active = c.uid === activeAdminChatUid;
        return `
          <div class="admin-row-actions" data-chat-thread="${c.uid}" style="display:block; padding:var(--sp-3); border-radius:var(--r-sm); cursor:pointer; margin-bottom:4px; ${active ? "background:var(--glass-bg-strong);" : ""}">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="font-size:var(--fs-sm);">${escapeHtml(c.userEmail || c.userName || c.uid)}</strong>
              ${c.unreadByAdmin ? `<span style="width:8px; height:8px; border-radius:50%; background:var(--c-warning); display:inline-block;"></span>` : ""}
            </div>
            <div class="u-text-muted" style="font-size:var(--fs-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(c.lastMessage || "")}</div>
            <div class="u-text-muted" style="font-size:10px;">${ms ? new Date(ms).toLocaleString() : ""}</div>
          </div>`;
      }).join("");
      el.querySelectorAll("[data-chat-thread]").forEach(row => {
        row.addEventListener("click", () => openAdminChatThread(row.dataset.chatThread));
      });
    }

    function adminChatMessageHTML(m){
      const ms = (m.createdAt && m.createdAt.toMillis) ? m.createdAt.toMillis() : 0;
      const mine = m.senderType === "admin";
      const attachment = m.attachmentURL
        ? (m.attachmentType && m.attachmentType.startsWith("image/")
            ? `<a href="${escapeHtml(m.attachmentURL)}" target="_blank" rel="noopener"><img src="${escapeHtml(m.attachmentURL)}" alt="Attachment" style="max-width:180px; border-radius:var(--r-sm); margin-top:6px; display:block;"></a>`
            : `<a href="${escapeHtml(m.attachmentURL)}" target="_blank" rel="noopener" style="display:inline-block; margin-top:6px; font-size:var(--fs-xs); color:var(--c-gold-300);">📎 View attachment</a>`)
        : "";
      return `
        <div class="ticket-message ${mine ? "ticket-message--user" : "ticket-message--support"}">
          <div class="ticket-message__bubble">${escapeHtml(m.message || "")}${attachment}</div>
          <div class="ticket-message__meta">${escapeHtml(m.senderName || (mine ? "Support" : "User"))} · ${ms ? new Date(ms).toLocaleString() : ""}</div>
        </div>`;
    }

    function openAdminChatThread(uid){
      activeAdminChatUid = uid;
      renderAdminChatThreadList();
      const thread = adminChatThreadsCache.find(c => c.uid === uid);
      const panel = document.getElementById("adminChatPanel");
      panel.innerHTML = `
        <div class="ticket-thread" id="adminChatMessages" style="min-height:320px;">
          <div class="skeleton skeleton--text w-60"></div>
        </div>
        <div class="u-text-muted u-hidden" id="adminChatTypingIndicator" style="font-size:var(--fs-xs); margin:6px 0;">User is typing…</div>
        <form class="ticket-reply-form" id="adminChatForm">
          <textarea class="form-input" id="adminChatInput" rows="1" placeholder="Reply to ${escapeHtml(thread ? (thread.userEmail || thread.userName || "user") : "user")}…"></textarea>
          <input type="file" id="adminChatAttachment" accept="image/jpeg,image/png,image/webp,application/pdf" style="max-width:140px; font-size:var(--fs-xs);">
          <button class="btn btn--primary" type="submit" id="adminChatSendBtn">Send</button>
        </form>`;
      const messagesEl = document.getElementById("adminChatMessages");
      if (adminChatMessagesUnsub){ try{ adminChatMessagesUnsub(); }catch(e){} }
      adminChatMessagesUnsub = window.YF.chat.subscribeToThreadMessages(uid, (messages) => {
        messagesEl.innerHTML = messages.length ? messages.map(adminChatMessageHTML).join("") : `<p class="u-text-muted">No messages yet.</p>`;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
      window.YF.chat.adminMarkRead(uid);
      const form = document.getElementById("adminChatForm");
      const input = document.getElementById("adminChatInput");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const attachmentInput = document.getElementById("adminChatAttachment");
        const attachmentFile = attachmentInput && attachmentInput.files ? attachmentInput.files[0] : null;
        if (!input.value.trim() && !attachmentFile) return;
        const btn = document.getElementById("adminChatSendBtn");
        btn.disabled = true;
        try{
          await window.YF.chat.adminSendMessage(uid, input.value, attachmentFile);
          input.value = "";
          if (attachmentInput) attachmentInput.value = "";
          window.YF.chat.adminSetTyping(uid, false);
        }catch(err){
          window.YF.ui.toast({ type:"danger", title:"Couldn't send message", message: err.message || "Please try again." });
        }finally{
          btn.disabled = false;
        }
      });
      let typingTimeout;
      input.addEventListener("input", () => {
        window.YF.chat.adminSetTyping(uid, true);
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => window.YF.chat.adminSetTyping(uid, false), 2500);
      });
    }

    /** Entry point wired from handleRouteClick for data-route="admin-chat". */
    function renderAdminChatPage(){
      if (!canManage('admin-chat')){
        window.YF.ui.navigateTo("home");
        return;
      }
      if (adminChatThreadsUnsub){ try{ adminChatThreadsUnsub(); }catch(e){} }
      adminChatThreadsUnsub = window.YF.chat.subscribeAllThreads((list) => {
        adminChatThreadsCache = list;
        updateChatPendingBadge();
        renderAdminChatThreadList();
      });
    }

    /* ---------------------------------------------------------
       BLOG (Phase E)
       Posts CRUD + lightweight category management via YF.blog.
       --------------------------------------------------------- */
    let adminBlogPostsCache = [];
    let adminBlogCategoriesCache = [];
    let adminBlogPostsUnsub = null;
    let adminBlogCategoriesUnsub = null;
    let adminBlogBound = false;

    function renderBlogCategoriesManageList(){
      const el = document.getElementById("blogCategoriesManageList");
      if (!el) return;
      el.innerHTML = adminBlogCategoriesCache.length
        ? adminBlogCategoriesCache.map(c => `
            <span class="chip">${escapeHtml(c.label)} <button type="button" data-delete-blog-category="${c.id}" style="background:none;border:none;color:inherit;cursor:pointer;margin-left:4px;">×</button></span>
          `).join("")
        : `<span class="u-text-muted" style="font-size:var(--fs-xs);">No categories yet — add one below.</span>`;
      const select = document.getElementById("blogPostFormCategory");
      if (select){
        const current = select.value;
        select.innerHTML = adminBlogCategoriesCache.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("") || `<option value="general">General</option>`;
        if (current) select.value = current;
      }
    }

    function renderAdminBlogPostsTable(){
      const tbody = document.getElementById("adminBlogPostsTableBody");
      if (!tbody) return;
      if (!adminBlogPostsCache.length){
        tbody.innerHTML = `<tr><td colspan="6"><div class="admin-empty-state">No posts yet — create your first one.</div></td></tr>`;
        return;
      }
      const catLabel = (id) => { const c = adminBlogCategoriesCache.find(x => x.id === id); return c ? c.label : (id || "General"); };
      tbody.innerHTML = adminBlogPostsCache.map(p => `
        <tr data-blog-post-row="${p.id}">
          <td>${escapeHtml(p.title)}</td>
          <td class="u-text-muted">${escapeHtml(catLabel(p.category))}</td>
          <td><span class="status-badge status-badge--${p.status === "published" ? "published" : "draft"}">${escapeHtml(p.status)}</span></td>
          <td>${p.commentCount || 0}</td>
          <td>${p.viewCount || 0}</td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-blog-post="${p.id}">Edit</button>
              <button type="button" class="admin-action-btn ${p.status === "published" ? "" : "admin-action-btn--success"}" data-toggle-blog-status="${p.id}" data-current-status="${p.status}">${p.status === "published" ? "Unpublish" : "Publish"}</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-blog-post="${p.id}">Delete</button>
            </div>
          </td>
        </tr>`).join("");
    }

    function openBlogPostForm(id){
      const form = document.getElementById("blogPostForm");
      form.reset();
      document.getElementById("blogPostFormId").value = id || "";
      renderBlogCategoriesManageList();
      if (id){
        const p = adminBlogPostsCache.find(x => x.id === id);
        if (!p) return;
        document.getElementById("blogPostFormModalTitle").textContent = "Edit Post";
        document.getElementById("blogPostFormTitle").value = p.title || "";
        document.getElementById("blogPostFormSlug").value = p.slug || "";
        document.getElementById("blogPostFormCategory").value = p.category || "general";
        document.getElementById("blogPostFormExcerpt").value = p.excerpt || "";
        document.getElementById("blogPostFormContent").value = p.content || "";
        document.getElementById("blogPostFormImage").value = p.featuredImage || "";
        document.getElementById("blogPostFormStatus").value = p.status || "draft";
        document.getElementById("blogPostFormSeoTitle").value = p.seoTitle || "";
        document.getElementById("blogPostFormSeoDescription").value = p.seoDescription || "";
      } else {
        document.getElementById("blogPostFormModalTitle").textContent = "New Post";
      }
      window.YF.ui.openModal("blogPostFormModal");
    }

    function bindAdminBlogPage(){
      if (adminBlogBound) return;
      adminBlogBound = true;
      document.getElementById("newBlogPostBtn").addEventListener("click", () => openBlogPostForm(null));
      document.getElementById("adminBlogPostsTableBody").addEventListener("click", async (e) => {
        const editBtn = e.target.closest("[data-edit-blog-post]");
        const toggleBtn = e.target.closest("[data-toggle-blog-status]");
        const delBtn = e.target.closest("[data-delete-blog-post]");
        if (editBtn) openBlogPostForm(editBtn.dataset.editBlogPost);
        if (toggleBtn){
          const newStatus = toggleBtn.dataset.currentStatus === "published" ? "draft" : "published";
          try{ await window.YF.blog.setStatus(toggleBtn.dataset.toggleBlogStatus, newStatus); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't update status", message: err.message || "Please try again." }); }
        }
        if (delBtn){
          if (!confirm("Delete this post permanently? This cannot be undone.")) return;
          try{ await window.YF.blog.deletePost(delBtn.dataset.deleteBlogPost); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't delete post", message: err.message || "Please try again." }); }
        }
      });
      document.getElementById("blogCategoriesManageList").addEventListener("click", async (e) => {
        const delBtn = e.target.closest("[data-delete-blog-category]");
        if (!delBtn) return;
        try{ await window.YF.blog.deleteCategory(delBtn.dataset.deleteBlogCategory); }
        catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't delete category", message: err.message || "Please try again." }); }
      });
      document.getElementById("newBlogCategoryForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("newBlogCategoryInput");
        try{
          await window.YF.blog.addCategory(input.value);
          input.value = "";
        }catch(err){
          window.YF.ui.toast({ type:"danger", title:"Couldn't add category", message: err.message || "Please try again." });
        }
      });
      document.getElementById("blogPostForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = document.getElementById("blogPostFormSubmitBtn");
        btn.disabled = true; btn.textContent = "Saving…";
        try{
          await window.YF.blog.savePost(document.getElementById("blogPostFormId").value || null, {
            title: document.getElementById("blogPostFormTitle").value,
            slug: document.getElementById("blogPostFormSlug").value,
            category: document.getElementById("blogPostFormCategory").value,
            excerpt: document.getElementById("blogPostFormExcerpt").value,
            content: document.getElementById("blogPostFormContent").value,
            featuredImage: document.getElementById("blogPostFormImage").value,
            status: document.getElementById("blogPostFormStatus").value,
            seoTitle: document.getElementById("blogPostFormSeoTitle").value.trim() || null,
            seoDescription: document.getElementById("blogPostFormSeoDescription").value.trim() || null
          });
          window.YF.ui.toast({ type:"success", title:"Post saved" });
          window.YF.ui.closeModal("blogPostFormModal");
        }catch(err){
          window.YF.ui.toast({ type:"danger", title:"Couldn't save post", message: err.message || "Please try again." });
        }finally{
          btn.disabled = false; btn.textContent = "Save Post";
        }
      });
    }

    /** Entry point wired from handleRouteClick for data-route="admin-blog". */
    function renderAdminBlogPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindAdminBlogPage();
      if (!adminBlogCategoriesUnsub){
        adminBlogCategoriesUnsub = window.YF.blog.subscribeCategories((cats) => {
          adminBlogCategoriesCache = cats;
          renderBlogCategoriesManageList();
          renderAdminBlogPostsTable();
        });
      }
      if (!adminBlogPostsUnsub){
        adminBlogPostsUnsub = window.YF.blog.subscribeAllPosts((posts) => {
          adminBlogPostsCache = posts;
          renderAdminBlogPostsTable();
        });
      } else {
        renderAdminBlogPostsTable();
      }
    }

    /* ---------------------------------------------------------
       CONTACT MESSAGES (Phase E)
       --------------------------------------------------------- */
    let adminContactMessagesCache = [];
    let adminContactMessagesUnsub = null;
    let adminContactBound = false;

    function updateContactPendingBadge(){
      const badge = document.getElementById("adminContactPendingBadge");
      if (!badge) return;
      const count = adminContactMessagesCache.filter(m => !m.read).length;
      badge.textContent = String(count);
      badge.classList.toggle("u-hidden", count === 0);
    }

    function renderAdminContactMessagesTable(){
      const tbody = document.getElementById("adminContactMessagesTableBody");
      if (!tbody) return;
      const list = [...adminContactMessagesCache].sort((a, b) => {
        const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
        const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
        return bt - at;
      });
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="5"><div class="admin-empty-state">No messages yet.</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(m => {
        const ms = (m.createdAt && m.createdAt.toMillis) ? m.createdAt.toMillis() : 0;
        return `
        <tr data-contact-msg-row="${m.id}" style="${m.read ? "" : "font-weight:700;"}">
          <td>${escapeHtml(m.name)} <div class="u-text-muted" style="font-weight:400; font-size:var(--fs-xs);">${escapeHtml(m.email)}</div></td>
          <td>${escapeHtml(m.subject)}</td>
          <td class="u-text-muted" style="font-weight:400; max-width:280px;">${escapeHtml(m.message)}</td>
          <td class="u-text-muted" style="font-weight:400;">${ms ? new Date(ms).toLocaleString() : "—"}</td>
          <td>
            <div class="admin-row-actions">
              ${!m.read ? `<button type="button" class="admin-action-btn" data-mark-contact-read="${m.id}">Mark Read</button>` : ""}
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-contact-msg="${m.id}">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join("");
    }

    function bindAdminContactMessagesPage(){
      if (adminContactBound) return;
      adminContactBound = true;
      document.getElementById("adminContactMessagesTableBody").addEventListener("click", async (e) => {
        const readBtn = e.target.closest("[data-mark-contact-read]");
        const delBtn = e.target.closest("[data-delete-contact-msg]");
        if (readBtn){
          try{ await window.YF.contact.markRead(readBtn.dataset.markContactRead); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't update", message: err.message || "Please try again." }); }
        }
        if (delBtn){
          try{ await window.YF.contact.remove(delBtn.dataset.deleteContactMsg); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Couldn't delete", message: err.message || "Please try again." }); }
        }
      });
    }

    /** Entry point wired from handleRouteClick for data-route="admin-contact-messages". */
    function renderAdminContactMessagesPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindAdminContactMessagesPage();
      if (!adminContactMessagesUnsub){
        adminContactMessagesUnsub = window.YF.contact.subscribeAll((list) => {
          adminContactMessagesCache = list;
          updateContactPendingBadge();
          renderAdminContactMessagesTable();
        });
      } else {
        renderAdminContactMessagesTable();
      }
    }


    /* ---------------------------------------------------------
       ADMIN DASHBOARD
       --------------------------------------------------------- */
    function activityDotClass(status){
      if (status === "approved") return "admin-activity-item__dot--success";
      if (status === "rejected") return "admin-activity-item__dot--danger";
      if (status === "pending") return "admin-activity-item__dot--warning";
      return "";
    }

    function timeAgo(ms){
      if (!ms) return "";
      const diff = Date.now() - ms;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      return `${days}d ago`;
    }

    function renderOrdersChart(orders){
      const chart = document.getElementById("adminOrdersChart");
      if (!chart) return;
      const DAY = 86400000;
      const today = new Date(); today.setHours(0,0,0,0);
      const buckets = [];
      for (let i = 6; i >= 0; i--){
        const dayStart = today.getTime() - i * DAY;
        buckets.push({ start: dayStart, end: dayStart + DAY, count: 0, label: new Date(dayStart).toLocaleDateString(undefined, { weekday: "short" }) });
      }
      orders.forEach(o => {
        const t = (o.createdAt && o.createdAt.toMillis) ? o.createdAt.toMillis() : (typeof o.createdAt === "number" ? o.createdAt : 0);
        const bucket = buckets.find(b => t >= b.start && t < b.end);
        if (bucket) bucket.count++;
      });
      const max = Math.max(1, ...buckets.map(b => b.count));
      chart.innerHTML = buckets.map(b => `
        <div class="admin-bar-chart__col">
          <div class="admin-bar-chart__bar" data-value="${b.count}" style="height:${Math.max(4, Math.round((b.count / max) * 100))}%;"></div>
          <div class="admin-bar-chart__label">${b.label}</div>
        </div>
      `).join("");
    }

    function renderActivityFeed(orders){
      const feed = document.getElementById("adminActivityFeed");
      if (!feed) return;
      const sorted = [...orders].sort((a, b) => {
        const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : (a.createdAt || 0);
        const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : (b.createdAt || 0);
        return bt - at;
      }).slice(0, 10);
      if (!sorted.length){
        feed.innerHTML = `<li class="u-text-muted">No recent activity yet.</li>`;
        return;
      }
      feed.innerHTML = sorted.map(o => {
        const t = (o.createdAt && o.createdAt.toMillis) ? o.createdAt.toMillis() : (o.createdAt || 0);
        const verb = o.status === "approved" ? "Order approved" : o.status === "rejected" ? "Order rejected" : o.status === "refunded" ? "Order refunded" : "New order placed";
        return `
          <li class="admin-activity-item">
            <span class="admin-activity-item__dot ${activityDotClass(o.status)}"></span>
            <div>
              <div class="admin-activity-item__title">${escapeHtml(verb)} — ${escapeHtml(o.productTitle || "Product")}</div>
              <div class="admin-activity-item__meta">${escapeHtml(o.buyerEmail || o.buyerName || "Unknown buyer")} · ${formatPrice(o.amount)} · ${timeAgo(t)}</div>
            </div>
          </li>
        `;
      }).join("");
    }

    /** Entry point wired from handleRouteClick for data-route="admin-dashboard".
     *  Independently re-verifies isAdmin() before issuing any read. */
    async function renderDashboard(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      const fb = window.YF.firebase;
      const usersEl   = document.getElementById("adminStatUsers");
      const revenueEl = document.getElementById("adminStatRevenue");
      const ordersEl  = document.getElementById("adminStatOrders");
      const pendingEl = document.getElementById("adminStatPending");

      if (!(fb && fb.db && fb.collection && fb.getDocs)){
        // No live backend available — render honest zero-state stats
        // instead of fabricated numbers.
        if (usersEl) usersEl.textContent = "—";
        if (revenueEl) revenueEl.textContent = formatMoney(0);
        if (ordersEl) ordersEl.textContent = "—";
        if (pendingEl) pendingEl.textContent = "—";
        renderOrdersChart([]);
        renderActivityFeed([]);
        return;
      }

      try{
        const [usersSnap, ordersSnap] = await Promise.all([
          fb.getDocs(fb.collection(fb.db, "users")),
          fb.getDocs(fb.collection(fb.db, "orders"))
        ]);
        const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const revenue = orders.filter(o => o.status === "approved").reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
        const pending = orders.filter(o => o.status === "pending").length;

        if (usersEl) usersEl.textContent = usersSnap.size.toLocaleString();
        if (revenueEl) revenueEl.textContent = formatMoney(revenue);
        if (ordersEl) ordersEl.textContent = orders.length.toLocaleString();
        if (pendingEl) pendingEl.textContent = pending.toLocaleString();

        renderOrdersChart(orders);
        renderActivityFeed(orders);
      }catch(err){
        console.error("YF.admin: renderDashboard failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't load dashboard", message:"Some admin stats failed to load." });
      }
    }

    /* ---------------------------------------------------------
       SITE SETTINGS
       Single-doc editor against settings/site. Reads its working
       copy from window.YF.siteSettings (already subscribed live),
       so the form always reflects the same data every visitor sees,
       and writes the FULL settings object back on save (never a
       partial patch) so nothing gets silently dropped.
       --------------------------------------------------------- */

    function syncColorHexPair(colorId, hexId){
      const colorInput = document.getElementById(colorId);
      const hexInput = document.getElementById(hexId);
      if (!colorInput || !hexInput) return;
      if (colorInput.dataset.bound !== "true"){
        colorInput.addEventListener("input", () => { hexInput.value = colorInput.value; });
        colorInput.dataset.bound = "true";
      }
      if (hexInput.dataset.bound !== "true"){
        hexInput.addEventListener("input", () => {
          if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) colorInput.value = hexInput.value;
        });
        hexInput.dataset.bound = "true";
      }
    }

    function populateSiteSettingsForm(){
      const s = (window.YF.siteSettings && window.YF.siteSettings.getSite()) || {};
      const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
      const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v !== false; };

      val("siteFormName", s.siteName);
      val("siteFormLogoUrl", s.logoUrl);
      val("siteFormFaviconUrl", s.faviconUrl);
      val("siteFormPrimaryColor", s.primaryColor || "#d4af37");
      val("siteFormPrimaryColorHex", s.primaryColor || "#d4af37");
      val("siteFormBgColor", s.bgColor || "#000000");
      val("siteFormBgColorHex", s.bgColor || "#000000");

      const hero = s.hero || {};
      val("siteFormHeroEyebrow", hero.eyebrow);
      val("siteFormHeroTitle", hero.title);
      val("siteFormHeroSubtitle", hero.subtitle);
      val("siteFormHeroCtaPrimary", hero.ctaPrimaryText);
      val("siteFormHeroCtaSecondary", hero.ctaSecondaryText);

      const stats = s.stats || {};
      val("siteFormStatCreators", stats.creators);
      val("siteFormStatDownloads", stats.downloads);
      val("siteFormStatAvgRating", stats.avgRating);

      const sections = s.sections || {};
      chk("siteFormSectionCategories", sections.categories);
      chk("siteFormSectionFeatured", sections.featured);
      chk("siteFormSectionHeroStats", sections.heroStats);
      chk("siteFormSectionLatest", sections.latest);
      chk("siteFormSectionPopular", sections.popular);
      chk("siteFormSectionTestimonials", sections.testimonials);
      val("siteFormTaxRate", s.taxRatePercent != null ? s.taxRatePercent : 0);
      val("siteFormFirstOrderDiscount", s.firstOrderDiscountPercent != null ? s.firstOrderDiscountPercent : 0);
      val("siteFormBulkBuyMinQty", s.bulkBuyMinQty != null ? s.bulkBuyMinQty : 0);
      val("siteFormBulkBuyDiscount", s.bulkBuyDiscountPercent != null ? s.bulkBuyDiscountPercent : 0);
      val("siteFormReferralReward", s.referralRewardAmount != null ? s.referralRewardAmount : 0);
      val("siteFormAffiliateCommission", s.affiliateFlatCommission != null ? s.affiliateFlatCommission : 5);
      val("siteFormPkrRate", s.pkrRate != null ? s.pkrRate : 290);
      val("siteFormContactEmail", s.contactEmail);
      val("siteFormContactPhone", s.contactPhone);
      val("siteFormContactAddress", s.contactAddress);

      setUploadDoneUI("logo", s.logoUrl ? "current logo" : "", 0, s.logoUrl);
      setUploadDoneUI("favicon", s.faviconUrl ? "current favicon" : "", 0, s.faviconUrl);
    }

    async function saveSiteSettings(e){
      e.preventDefault();
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
      const isChecked = (id) => { const el = document.getElementById(id); return el ? el.checked : true; };

      const payload = {
        siteName: get("siteFormName") || "YouForge Hub",
        logoUrl: get("siteFormLogoUrl"),
        faviconUrl: get("siteFormFaviconUrl"),
        primaryColor: get("siteFormPrimaryColorHex") || get("siteFormPrimaryColor") || "#d4af37",
        bgColor: get("siteFormBgColorHex") || get("siteFormBgColor") || "#000000",
        hero: {
          eyebrow: get("siteFormHeroEyebrow"),
          title: get("siteFormHeroTitle"),
          subtitle: get("siteFormHeroSubtitle"),
          ctaPrimaryText: get("siteFormHeroCtaPrimary"),
          ctaSecondaryText: get("siteFormHeroCtaSecondary")
        },
        stats: {
          creators: get("siteFormStatCreators"),
          downloads: get("siteFormStatDownloads"),
          avgRating: get("siteFormStatAvgRating")
        },
        sections: {
          categories: isChecked("siteFormSectionCategories"),
          featured: isChecked("siteFormSectionFeatured"),
          heroStats: isChecked("siteFormSectionHeroStats"),
          latest: isChecked("siteFormSectionLatest"),
          popular: isChecked("siteFormSectionPopular"),
          testimonials: isChecked("siteFormSectionTestimonials")
        },
        taxRatePercent: Math.max(0, Math.min(100, Number(get("siteFormTaxRate")) || 0)),
        firstOrderDiscountPercent: Math.max(0, Math.min(100, Number(get("siteFormFirstOrderDiscount")) || 0)),
        bulkBuyMinQty: Math.max(0, Number(get("siteFormBulkBuyMinQty")) || 0),
        bulkBuyDiscountPercent: Math.max(0, Math.min(100, Number(get("siteFormBulkBuyDiscount")) || 0)),
        referralRewardAmount: Math.max(0, Number(get("siteFormReferralReward")) || 0),
        affiliateFlatCommission: Math.max(0, Number(get("siteFormAffiliateCommission")) || 0),
        pkrRate: Math.max(1, Number(get("siteFormPkrRate")) || 290),
        contactEmail: get("siteFormContactEmail"),
        contactPhone: get("siteFormContactPhone"),
        contactAddress: get("siteFormContactAddress")
      };

      const btn = document.getElementById("siteSettingsSubmitBtn");
      if (btn){ btn.disabled = true; btn.textContent = "Saving…"; }
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        payload.updatedAt = fb.serverTimestamp();
        await fb.setDoc(fb.doc(fb.db, "settings", "site"), payload, { merge: true });
        window.YF.ui.toast({ type:"success", title:"Site settings saved", message:"Your changes are now live for every visitor." });
      }catch(err){
        console.error("YF.admin: saveSiteSettings failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save settings", message: err.message || "Please try again." });
      }finally{
        if (btn){ btn.disabled = false; btn.textContent = "Save Site Settings"; }
      }
    }

    function bindSiteSettingsPage(){
      const form = document.getElementById("siteSettingsForm");
      if (form && form.dataset.bound !== "true"){
        form.addEventListener("submit", saveSiteSettings);
        form.dataset.bound = "true";
      }
      const seoForm = document.getElementById("seoSettingsForm");
      if (seoForm && seoForm.dataset.bound !== "true"){
        seoForm.addEventListener("submit", saveSeoSettings);
        seoForm.dataset.bound = "true";
      }
      syncColorHexPair("siteFormPrimaryColor", "siteFormPrimaryColorHex");
      syncColorHexPair("siteFormBgColor", "siteFormBgColorHex");
      bindExtraUploadInputs([
        { field: "logo", removeBtnId: "siteFormLogoRemoveBtn", urlInputId: "siteFormLogoUrl" },
        { field: "favicon", removeBtnId: "siteFormFaviconRemoveBtn", urlInputId: "siteFormFaviconUrl" }
      ]);
      if (!siteSettingsBound){
        // Re-populate the form live whenever the settings doc changes
        // elsewhere (e.g. another admin tab saving at the same time).
        if (window.YF.siteSettings) window.YF.siteSettings.onUpdate(() => {
          if (!document.getElementById("page-admin-settings").classList.contains("u-hidden")) populateSiteSettingsForm();
        });
        if (window.YF.seo) window.YF.seo.onUpdate(() => {
          if (!document.getElementById("page-admin-settings").classList.contains("u-hidden")) populateSeoSettingsForm();
        });
        siteSettingsBound = true;
      }
    }

    function populateSeoSettingsForm(){
      const s = (window.YF.seo && window.YF.seo.getDefaults()) || {};
      const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
      val("seoFormDefaultTitle", s.defaultTitle);
      val("seoFormDefaultDescription", s.defaultDescription);
      val("seoFormDefaultKeywords", s.defaultKeywords);
      val("seoFormOgImage", s.ogImage);
      val("seoFormTwitterHandle", s.twitterHandle);
    }

    async function saveSeoSettings(e){
      e.preventDefault();
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
      const btn = document.getElementById("seoSettingsSubmitBtn");
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        await fb.setDoc(fb.doc(fb.db, "settings", "seo"), {
          defaultTitle: get("seoFormDefaultTitle") || "YouForge Hub — Digital Marketplace",
          defaultDescription: get("seoFormDefaultDescription"),
          defaultKeywords: get("seoFormDefaultKeywords"),
          ogImage: get("seoFormOgImage"),
          twitterHandle: get("seoFormTwitterHandle")
        }, { merge: true });
        window.YF.ui.toast({ type:"success", title:"SEO defaults saved" });
      }catch(err){
        window.YF.ui.toast({ type:"danger", title:"Couldn't save", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save SEO Defaults";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-settings". */
    function renderSiteSettingsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindSiteSettingsPage();
      populateSiteSettingsForm();
      populateSeoSettingsForm();
    }

    /* ---------------------------------------------------------
       PAYMENT METHODS MANAGER
       Full CRUD over the single "methods" array field stored on
       settings/paymentMethods. Every save/delete reads the current
       array (from window.YF.siteSettings, kept live by its own
       onSnapshot listener), mutates it in memory, and writes the
       WHOLE array back — matching the same "always write the full
       object" discipline used everywhere else in this file.
       Matching Firestore security rule:
         match /settings/{docId} {
           allow read: if true;
           allow write: if request.auth != null && isAdmin();
         }
       --------------------------------------------------------- */

    function paymentMethodIcon(id){
      const icons = {
        jazzcash: "📱", easypaisa: "📱", bank: "🏦", crypto: "🪙"
      };
      return icons[id] || "💳";
    }

    function renderPaymentMethodsTable(){
      const tbody = document.getElementById("adminPaymentMethodsTableBody");
      if (!tbody) return;
      const q = paymentMethodSearch.trim().toLowerCase();
      const list = paymentMethodsCache.filter(m =>
        !q || String(m.label || m.id).toLowerCase().includes(q) || String(m.accountTitle || "").toLowerCase().includes(q)
      );
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="6"><div class="admin-empty-state">${
          paymentMethodsCache.length ? "No payment methods match your search." : "No payment methods yet — add JazzCash, EasyPaisa, Bank, or Crypto to start accepting orders."
        }</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(m => `
        <tr data-payment-method-row="${escapeHtml(m.id)}">
          <td>
            <div class="product-row__title">${paymentMethodIcon(m.id)} ${escapeHtml(m.label || m.id)}</div>
            <div class="u-text-muted" style="font-size:var(--fs-xs);">${escapeHtml(m.type || "")}</div>
          </td>
          <td>${escapeHtml(m.accountTitle || "—")}</td>
          <td><span class="category-id-chip">${escapeHtml(m.accountNumber || "—")}</span></td>
          <td>${m.qrUrl ? `<img src="${escapeHtml(m.qrUrl)}" class="screenshot-thumb" alt="QR code" data-view-screenshot="${escapeHtml(m.qrUrl)}" loading="lazy" decoding="async">` : `<span class="u-text-muted">—</span>`}</td>
          <td><span class="status-badge ${m.active === false ? "status-badge--draft" : "status-badge--active"}">${m.active === false ? "Inactive" : "Active"}</span></td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-payment-method="${escapeHtml(m.id)}">Edit</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-payment-method="${escapeHtml(m.id)}">Delete</button>
            </div>
          </td>
        </tr>
      `).join("");
    }

    function refreshPaymentMethodsCacheFromSiteSettings(){
      const list = (window.YF.siteSettings && window.YF.siteSettings.getPaymentMethods()) || [];
      paymentMethodsCache = list.map(m => Object.assign({}, m));
      renderPaymentMethodsTable();
    }

    function openPaymentMethodForm(mode, methodId){
      const form = document.getElementById("paymentMethodForm");
      const title = document.getElementById("paymentMethodFormModalTitle");
      const idInput = document.getElementById("pmFormId");
      form.reset();
      resetUploadUI("pmQr");
      document.getElementById("pmFormMode").value = mode;
      document.getElementById("pmFormActive").checked = true;
      if (mode === "edit"){
        const m = paymentMethodsCache.find(x => x.id === methodId);
        if (!m) return;
        document.getElementById("pmFormLabel").value = m.label || "";
        idInput.value = m.id;
        idInput.disabled = true;
        document.getElementById("pmFormType").value = m.type || "";
        document.getElementById("pmFormAccountTitle").value = m.accountTitle || "";
        document.getElementById("pmFormAccountNumber").value = m.accountNumber || "";
        document.getElementById("pmFormExtraLabel").value = m.extraLabel || "";
        document.getElementById("pmFormExtraValue").value = m.extraValue || "";
        document.getElementById("pmFormInstructions").value = Array.isArray(m.instructions) ? m.instructions.join("\n") : (m.instructions || "");
        document.getElementById("pmFormQrUrl").value = m.qrUrl || "";
        if (m.qrUrl) setUploadDoneUI("pmQr", "current QR code", 0, m.qrUrl);
        document.getElementById("pmFormActive").checked = m.active !== false;
        title.textContent = "Edit Payment Method";
      } else {
        idInput.value = "";
        idInput.disabled = false;
        title.textContent = "New Payment Method";
      }
      window.YF.ui.openModal("paymentMethodFormModal");
    }

    async function savePaymentMethod(e){
      e.preventDefault();
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const mode = document.getElementById("pmFormMode").value;
      const label = document.getElementById("pmFormLabel").value.trim();
      const accountTitle = document.getElementById("pmFormAccountTitle").value.trim();
      const accountNumber = document.getElementById("pmFormAccountNumber").value.trim();
      let id = document.getElementById("pmFormId").value.trim();
      if (!label || !accountTitle || !accountNumber){
        window.YF.ui.toast({ type:"danger", title:"Missing details", message:"Please fill in the method name, account title, and account number." });
        return;
      }
      if (mode === "create"){
        id = slugify(id || label);
        if (paymentMethodsCache.some(m => m.id === id)){
          window.YF.ui.toast({ type:"danger", title:"Method already exists", message:`A payment method with id "${id}" already exists.` });
          return;
        }
      }
      const instructions = document.getElementById("pmFormInstructions").value
        .split("\n").map(s => s.trim()).filter(Boolean);

      const methodObj = {
        id,
        label,
        type: document.getElementById("pmFormType").value.trim(),
        accountTitle,
        accountNumber,
        extraLabel: document.getElementById("pmFormExtraLabel").value.trim() || null,
        extraValue: document.getElementById("pmFormExtraValue").value.trim() || null,
        instructions,
        qrUrl: document.getElementById("pmFormQrUrl").value.trim() || "",
        active: document.getElementById("pmFormActive").checked
      };

      const btn = document.getElementById("paymentMethodFormSubmitBtn");
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        let updated;
        if (mode === "edit"){
          updated = paymentMethodsCache.map(m => m.id === id ? methodObj : m);
        } else {
          updated = [...paymentMethodsCache, methodObj];
        }
        await fb.setDoc(fb.doc(fb.db, "settings", "paymentMethods"), { methods: updated, updatedAt: fb.serverTimestamp() }, { merge: true });
        window.YF.ui.toast({ type:"success", title: mode === "edit" ? "Payment method updated" : "Payment method added", message:`"${label}" is now saved.` });
        logActivity("payment-method-save", `${mode === "edit" ? "Updated" : "Added"} payment method "${label}"`);
        window.YF.ui.closeModal("paymentMethodFormModal");
      }catch(err){
        console.error("YF.admin: savePaymentMethod failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save payment method", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Payment Method";
      }
    }

    function confirmDeletePaymentMethod(methodId){
      const m = paymentMethodsCache.find(x => x.id === methodId);
      if (!m) return;
      document.getElementById("deletePaymentMethodId").value = methodId;
      document.getElementById("deletePaymentMethodLabel").textContent = m.label || m.id;
      window.YF.ui.openModal("deletePaymentMethodModal");
    }

    async function performDeletePaymentMethod(){
      if (!isAdmin()) return;
      const fb = window.YF.firebase;
      const id = document.getElementById("deletePaymentMethodId").value;
      if (!id) return;
      const btn = document.getElementById("confirmDeletePaymentMethodBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        const updated = paymentMethodsCache.filter(m => m.id !== id);
        await fb.setDoc(fb.doc(fb.db, "settings", "paymentMethods"), { methods: updated, updatedAt: fb.serverTimestamp() }, { merge: true });
        window.YF.ui.toast({ type:"info", title:"Payment method deleted", message:"It was permanently removed from checkout." });
        logActivity("payment-method-delete", `Deleted payment method "${id}"`);
        window.YF.ui.closeModal("deletePaymentMethodModal");
      }catch(err){
        console.error("YF.admin: deletePaymentMethod failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete payment method", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    function bindPaymentMethodsPage(){
      const tbody = document.getElementById("adminPaymentMethodsTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-payment-method]");
          const delBtn = e.target.closest("[data-delete-payment-method]");
          const thumb = e.target.closest("[data-view-screenshot]");
          if (editBtn) openPaymentMethodForm("edit", editBtn.dataset.editPaymentMethod);
          if (delBtn) confirmDeletePaymentMethod(delBtn.dataset.deletePaymentMethod);
          if (thumb) window.open(thumb.dataset.viewScreenshot, "_blank", "noopener");
        });
        tbody.dataset.bound = "true";
      }
      const newBtn = document.getElementById("adminNewPaymentMethodBtn");
      if (newBtn && newBtn.dataset.bound !== "true"){
        newBtn.addEventListener("click", () => openPaymentMethodForm("create"));
        newBtn.dataset.bound = "true";
      }
      const form = document.getElementById("paymentMethodForm");
      if (form && form.dataset.bound !== "true"){
        form.addEventListener("submit", savePaymentMethod);
        form.dataset.bound = "true";
      }
      const confirmDelBtn = document.getElementById("confirmDeletePaymentMethodBtn");
      if (confirmDelBtn && confirmDelBtn.dataset.bound !== "true"){
        confirmDelBtn.addEventListener("click", performDeletePaymentMethod);
        confirmDelBtn.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminPaymentMethodSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { paymentMethodSearch = e.target.value; renderPaymentMethodsTable(); });
        searchInput.dataset.bound = "true";
      }
      bindExtraUploadInputs([
        { field: "pmQr", removeBtnId: "pmFormQrRemoveBtn", urlInputId: "pmFormQrUrl" }
      ]);
      if (!paymentMethodsUnsub && window.YF.siteSettings){
        window.YF.siteSettings.onUpdate(() => {
          if (!document.getElementById("page-admin-payment-methods").classList.contains("u-hidden")) refreshPaymentMethodsCacheFromSiteSettings();
        });
        paymentMethodsUnsub = true;
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-payment-methods". */
    function renderPaymentMethodsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindPaymentMethodsPage();
      refreshPaymentMethodsCacheFromSiteSettings();
    }

    /* ---------------------------------------------------------
       SOCIAL SETTINGS MANAGER
       Full CRUD over the single "links" array field stored on
       settings/socialLinks. Every save/delete reads the current
       array (from window.YF.social, kept live by its own onSnapshot
       listener), mutates it in memory, and writes the WHOLE array
       back — the same "always write the full object" discipline
       used by Payment Methods above.
       Matching Firestore security rule:
         match /settings/{docId} {
           allow read: if true;
           allow write: if request.auth != null && isAdmin();
         }
       --------------------------------------------------------- */

    function socialLinkMeta(l){
      const meta = (window.YF.social && window.YF.social.PLATFORM_META[l.platform]) || { label: "Custom Link", type: "Link" };
      return {
        label: l.platform === "custom" ? (l.label || "Custom Link") : meta.label,
        type: l.platform === "custom" ? "Custom" : meta.type
      };
    }

    function renderSocialLinksTable(){
      const tbody = document.getElementById("adminSocialLinksTableBody");
      if (!tbody) return;
      const q = socialLinkSearch.trim().toLowerCase();
      const list = socialLinksCache.filter(l => {
        const m = socialLinkMeta(l);
        return !q || m.label.toLowerCase().includes(q) || String(l.url || "").toLowerCase().includes(q);
      });
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="4"><div class="admin-empty-state">${
          socialLinksCache.length ? "No social links match your search." : "No social links yet — add your Website, WhatsApp, Telegram, or other community links so they appear on the login page."
        }</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(l => {
        const m = socialLinkMeta(l);
        return `
        <tr data-social-link-row="${escapeHtml(l.platform)}">
          <td>
            <div class="product-row__title">${escapeHtml(m.label)}</div>
            <div class="u-text-muted" style="font-size:var(--fs-xs);">${escapeHtml(m.type)}</div>
          </td>
          <td><span class="category-id-chip" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle;">${escapeHtml(l.url || "—")}</span></td>
          <td><span class="status-badge ${l.enabled === false ? "status-badge--draft" : "status-badge--active"}">${l.enabled === false ? "Disabled" : "Enabled"}</span></td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-social-link="${escapeHtml(l.platform)}">Edit</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-social-link="${escapeHtml(l.platform)}">Delete</button>
            </div>
          </td>
        </tr>
      `;
      }).join("");
    }

    function refreshSocialLinksCacheFromSocial(){
      const list = (window.YF.social && window.YF.social.getLinks()) || [];
      socialLinksCache = list.map(l => Object.assign({}, l));
      renderSocialLinksTable();
    }

    function openSocialLinkForm(mode, platformKey){
      const form = document.getElementById("socialLinkForm");
      const title = document.getElementById("socialLinkFormModalTitle");
      const platformSelect = document.getElementById("slFormPlatform");
      form.reset();
      document.getElementById("slFormLabelGroup").classList.add("u-hidden");
      document.getElementById("slFormMode").value = mode;
      document.getElementById("slFormOrigPlatform").value = "";
      document.getElementById("slFormEnabled").checked = true;
      if (mode === "edit"){
        const l = socialLinksCache.find(x => x.platform === platformKey);
        if (!l) return;
        platformSelect.value = l.platform;
        platformSelect.disabled = true;
        document.getElementById("slFormOrigPlatform").value = l.platform;
        document.getElementById("slFormUrl").value = l.url || "";
        document.getElementById("slFormEnabled").checked = l.enabled !== false;
        if (l.platform === "custom"){
          document.getElementById("slFormLabelGroup").classList.remove("u-hidden");
          document.getElementById("slFormLabel").value = l.label || "";
        }
        title.textContent = "Edit Social Link";
      } else {
        platformSelect.disabled = false;
        // Hide platforms already added (except "custom", which can be added repeatedly)
        Array.from(platformSelect.options).forEach(opt => {
          if (!opt.value || opt.value === "custom") return;
          opt.disabled = socialLinksCache.some(x => x.platform === opt.value);
        });
        title.textContent = "New Social Link";
      }
      window.YF.ui.openModal("socialLinkFormModal");
    }

    async function saveSocialLink(e){
      e.preventDefault();
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const mode = document.getElementById("slFormMode").value;
      const platform = document.getElementById("slFormPlatform").value;
      const url = document.getElementById("slFormUrl").value.trim();
      const isCustom = platform === "custom";
      const label = document.getElementById("slFormLabel").value.trim();

      setFieldError("slFormPlatform", "slFormPlatformError", !platform);
      setFieldError("slFormUrl", "slFormUrlError", !url);
      if (isCustom) setFieldError("slFormLabel", "slFormLabelError", !label);
      if (!platform || !url || (isCustom && !label)) return;

      if (mode === "create" && platform !== "custom" && socialLinksCache.some(l => l.platform === platform)){
        window.YF.ui.toast({ type:"danger", title:"Already added", message:"This platform is already in your list — edit it instead." });
        return;
      }

      const linkObj = {
        id: mode === "edit" ? document.getElementById("slFormOrigPlatform").value : (isCustom ? `custom_${Date.now()}` : platform),
        platform,
        label: isCustom ? label : "",
        url,
        enabled: document.getElementById("slFormEnabled").checked
      };

      const btn = document.getElementById("socialLinkFormSubmitBtn");
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        let updated;
        if (mode === "edit"){
          const origPlatform = document.getElementById("slFormOrigPlatform").value;
          updated = socialLinksCache.map(l => l.platform === origPlatform ? linkObj : l);
        } else {
          updated = [...socialLinksCache, linkObj];
        }
        await fb.setDoc(fb.doc(fb.db, "settings", "socialLinks"), { links: updated, updatedAt: fb.serverTimestamp() }, { merge: true });
        window.YF.ui.toast({ type:"success", title: mode === "edit" ? "Social link updated" : "Social link added", message:`"${socialLinkMeta(linkObj).label}" is now saved.` });
        logActivity("social-link-save", `${mode === "edit" ? "Updated" : "Added"} social link "${socialLinkMeta(linkObj).label}"`);
        window.YF.ui.closeModal("socialLinkFormModal");
      }catch(err){
        console.error("YF.admin: saveSocialLink failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save social link", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Social Link";
      }
    }

    function confirmDeleteSocialLink(platformKey){
      const l = socialLinksCache.find(x => x.platform === platformKey);
      if (!l) return;
      document.getElementById("deleteSocialLinkId").value = platformKey;
      document.getElementById("deleteSocialLinkLabel").textContent = socialLinkMeta(l).label;
      window.YF.ui.openModal("deleteSocialLinkModal");
    }

    async function performDeleteSocialLink(){
      if (!isAdmin()) return;
      const fb = window.YF.firebase;
      const platformKey = document.getElementById("deleteSocialLinkId").value;
      if (!platformKey) return;
      const btn = document.getElementById("confirmDeleteSocialLinkBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        const updated = socialLinksCache.filter(l => l.platform !== platformKey);
        await fb.setDoc(fb.doc(fb.db, "settings", "socialLinks"), { links: updated, updatedAt: fb.serverTimestamp() }, { merge: true });
        window.YF.ui.toast({ type:"info", title:"Social link deleted", message:"It was permanently removed from the login page." });
        logActivity("social-link-delete", `Deleted social link "${platformKey}"`);
        window.YF.ui.closeModal("deleteSocialLinkModal");
      }catch(err){
        console.error("YF.admin: deleteSocialLink failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete social link", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    function bindSocialSettingsPage(){
      const tbody = document.getElementById("adminSocialLinksTableBody");
      if (tbody && tbody.dataset.bound !== "true"){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-social-link]");
          const delBtn = e.target.closest("[data-delete-social-link]");
          if (editBtn) openSocialLinkForm("edit", editBtn.dataset.editSocialLink);
          if (delBtn) confirmDeleteSocialLink(delBtn.dataset.deleteSocialLink);
        });
        tbody.dataset.bound = "true";
      }
      const newBtn = document.getElementById("adminNewSocialLinkBtn");
      if (newBtn && newBtn.dataset.bound !== "true"){
        newBtn.addEventListener("click", () => openSocialLinkForm("create"));
        newBtn.dataset.bound = "true";
      }
      const form = document.getElementById("socialLinkForm");
      if (form && form.dataset.bound !== "true"){
        form.addEventListener("submit", saveSocialLink);
        form.dataset.bound = "true";
      }
      const platformSelect = document.getElementById("slFormPlatform");
      if (platformSelect && platformSelect.dataset.bound !== "true"){
        platformSelect.addEventListener("change", () => {
          document.getElementById("slFormLabelGroup").classList.toggle("u-hidden", platformSelect.value !== "custom");
        });
        platformSelect.dataset.bound = "true";
      }
      const confirmDelBtn = document.getElementById("confirmDeleteSocialLinkBtn");
      if (confirmDelBtn && confirmDelBtn.dataset.bound !== "true"){
        confirmDelBtn.addEventListener("click", performDeleteSocialLink);
        confirmDelBtn.dataset.bound = "true";
      }
      const searchInput = document.getElementById("adminSocialLinkSearch");
      if (searchInput && searchInput.dataset.bound !== "true"){
        searchInput.addEventListener("input", (e) => { socialLinkSearch = e.target.value; renderSocialLinksTable(); });
        searchInput.dataset.bound = "true";
      }
      if (!socialLinksUnsub && window.YF.social){
        window.YF.social.onUpdate(() => {
          if (!document.getElementById("page-admin-social-settings").classList.contains("u-hidden")) refreshSocialLinksCacheFromSocial();
        });
        socialLinksUnsub = true;
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-social-settings". */
    function renderSocialSettingsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindSocialSettingsPage();
      refreshSocialLinksCacheFromSocial();
    }

    /* ---------------------------------------------------------
       COMMUNICATION SETTINGS
       Four independent single-doc / single-array editors against
       settings/contact, settings/whatsapp, settings/telegram, and
       settings/social in the top-level "settings" Firestore
       collection. Each form saves only its own doc (merge:true),
       so saving WhatsApp never touches Telegram/Social/Contact data.

       createListManager() is a small reusable factory for the six
       repeatable arrays (WhatsApp numbers/groups/channels, Telegram
       groups/channels/bots) — it renders rows, tracks edits via
       event delegation (one listener per list, not per row), and
       hands back plain arrays ready to write straight to Firestore.
       --------------------------------------------------------- */

    function createListManager(containerId, addBtnId, fields, emptyItem){
      let items = [];

      function render(){
        const el = document.getElementById(containerId);
        if (!el) return;
        if (!items.length){
          el.innerHTML = `<div class="repeatable-list-empty">No entries yet — click "Add" above.</div>`;
          return;
        }
        el.innerHTML = items.map((it, idx) => `
          <div class="repeatable-row" data-idx="${idx}">
            ${fields.map(f => `<input class="form-input" type="${f.type || "text"}" placeholder="${escapeHtml(f.placeholder || "")}" data-field="${f.key}" value="${escapeHtml(it[f.key] || "")}">`).join("")}
            <button type="button" class="repeatable-row__remove" data-remove="${idx}" aria-label="Remove">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>`).join("");
      }

      function bind(){
        const el = document.getElementById(containerId);
        const addBtn = document.getElementById(addBtnId);
        if (el && el.dataset.bound !== "true"){
          el.addEventListener("input", (e) => {
            const row = e.target.closest(".repeatable-row");
            const field = e.target.dataset.field;
            if (!row || !field) return;
            const idx = Number(row.dataset.idx);
            if (items[idx]) items[idx][field] = e.target.value;
          });
          el.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-remove]");
            if (!btn) return;
            items.splice(Number(btn.dataset.remove), 1);
            render();
          });
          el.dataset.bound = "true";
        }
        if (addBtn && addBtn.dataset.bound !== "true"){
          addBtn.addEventListener("click", () => { items.push({ ...emptyItem }); render(); });
          addBtn.dataset.bound = "true";
        }
      }

      return {
        setItems(arr){ items = Array.isArray(arr) ? arr.map(x => ({ ...emptyItem, ...x })) : []; render(); },
        getItems(){ return items.filter(it => fields.some(f => String(it[f.key] || "").trim() !== "")); },
        bind
      };
    }

    const whatsappNumbersMgr  = createListManager("whatsappNumbersList",  "whatsappAddNumberBtn",  [{ key:"label", placeholder:"Label (e.g. Sales, Support)" }, { key:"number", placeholder:"Number with country code (e.g. +923001234567)" }], { label:"", number:"" });
    const whatsappGroupsMgr   = createListManager("whatsappGroupsList",   "whatsappAddGroupBtn",   [{ key:"name",  placeholder:"Group name" }, { key:"link", placeholder:"Invite link (https://chat.whatsapp.com/...)", type:"url" }], { name:"", link:"" });
    const whatsappChannelsMgr = createListManager("whatsappChannelsList", "whatsappAddChannelBtn", [{ key:"name",  placeholder:"Channel name" }, { key:"link", placeholder:"Invite link (https://whatsapp.com/channel/...)", type:"url" }], { name:"", link:"" });
    const telegramGroupsMgr   = createListManager("telegramGroupsList",   "telegramAddGroupBtn",   [{ key:"name",  placeholder:"Group name" }, { key:"link", placeholder:"Invite link (https://t.me/...)", type:"url" }], { name:"", link:"" });
    const telegramChannelsMgr = createListManager("telegramChannelsList", "telegramAddChannelBtn", [{ key:"name",  placeholder:"Channel name" }, { key:"link", placeholder:"Invite link (https://t.me/...)", type:"url" }], { name:"", link:"" });
    const telegramBotsMgr     = createListManager("telegramBotsList",     "telegramAddBotBtn",     [{ key:"name",  placeholder:"Bot name" }, { key:"link", placeholder:"Bot link (https://t.me/...)", type:"url" }], { name:"", link:"" });

    let communicationBound = false;

    async function loadCommunicationSettings(){
      const fb = window.YF.firebase;
      if (!(fb && fb.db)) return;

      try{
        const contactSnap = await fb.getDoc(fb.doc(fb.db, "settings", "contact"));
        const c = contactSnap.exists() ? contactSnap.data() : {};
        const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
        val("commContactPhone", c.phone);
        val("commContactEmail", c.email);
        val("commContactAddress", c.address);
        val("commContactHours", c.businessHours);
        val("commContactMapsUrl", c.mapsUrl);
      }catch(err){
        console.error("YF.admin: loading settings/contact failed", err);
      }

      try{
        const fcSnap = await fb.getDoc(fb.doc(fb.db, "settings", "floatingContact"));
        const fcData = fcSnap.exists() ? fcSnap.data() : {};
        const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
        val("commFloatingWhatsappNumber", fcData.whatsappNumber);
        val("commFloatingTelegramUsername", fcData.telegramUsername);
      }catch(err){
        console.error("YF.admin: loading settings/floatingContact failed", err);
      }

      try{
        const waSnap = await fb.getDoc(fb.doc(fb.db, "settings", "whatsapp"));
        const w = waSnap.exists() ? waSnap.data() : {};
        whatsappNumbersMgr.setItems(w.numbers);
        whatsappGroupsMgr.setItems(w.groups);
        whatsappChannelsMgr.setItems(w.channels);
      }catch(err){
        console.error("YF.admin: loading settings/whatsapp failed", err);
      }

      try{
        const tgSnap = await fb.getDoc(fb.doc(fb.db, "settings", "telegram"));
        const t = tgSnap.exists() ? tgSnap.data() : {};
        telegramGroupsMgr.setItems(t.groups);
        telegramChannelsMgr.setItems(t.channels);
        telegramBotsMgr.setItems(t.bots);
      }catch(err){
        console.error("YF.admin: loading settings/telegram failed", err);
      }

      try{
        const socSnap = await fb.getDoc(fb.doc(fb.db, "settings", "social"));
        const s = socSnap.exists() ? socSnap.data() : {};
        const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
        val("commSocialFacebook", s.facebook);
        val("commSocialInstagram", s.instagram);
        val("commSocialTiktok", s.tiktok);
        val("commSocialYoutube", s.youtube);
        val("commSocialX", s.x);
        val("commSocialLinkedin", s.linkedin);
        val("commSocialDiscord", s.discord);
        val("commSocialGithub", s.github);
      }catch(err){
        console.error("YF.admin: loading settings/social failed", err);
      }
    }

    async function saveSettingsDoc({ docId, payload, btnId, btnLabel, successTitle }){
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const btn = document.getElementById(btnId);
      if (btn){ btn.disabled = true; btn.textContent = "Saving…"; }
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        payload.updatedAt = fb.serverTimestamp();
        await fb.setDoc(fb.doc(fb.db, "settings", docId), payload, { merge: true });
        window.YF.ui.toast({ type:"success", title: successTitle, message:"Your changes are now live for every visitor." });
        logActivity("settings-update", `Updated settings/${docId} (${successTitle})`);
      }catch(err){
        console.error(`YF.admin: saving settings/${docId} failed`, err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save settings", message: err.message || "Please try again." });
      }finally{
        if (btn){ btn.disabled = false; btn.textContent = btnLabel; }
      }
    }

    function saveContactInfo(e){
      e.preventDefault();
      const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
      return saveSettingsDoc({
        docId: "contact",
        payload: {
          phone: get("commContactPhone"),
          email: get("commContactEmail"),
          address: get("commContactAddress"),
          businessHours: get("commContactHours"),
          mapsUrl: get("commContactMapsUrl")
        },
        btnId: "commContactSubmitBtn",
        btnLabel: "Save Contact Info",
        successTitle: "Contact info saved"
      });
    }

    function saveWhatsappSettings(e){
      e.preventDefault();
      return saveSettingsDoc({
        docId: "whatsapp",
        payload: {
          numbers: whatsappNumbersMgr.getItems(),
          groups: whatsappGroupsMgr.getItems(),
          channels: whatsappChannelsMgr.getItems()
        },
        btnId: "commWhatsappSubmitBtn",
        btnLabel: "Save WhatsApp Settings",
        successTitle: "WhatsApp settings saved"
      });
    }

    function saveTelegramSettings(e){
      e.preventDefault();
      return saveSettingsDoc({
        docId: "telegram",
        payload: {
          groups: telegramGroupsMgr.getItems(),
          channels: telegramChannelsMgr.getItems(),
          bots: telegramBotsMgr.getItems()
        },
        btnId: "commTelegramSubmitBtn",
        btnLabel: "Save Telegram Settings",
        successTitle: "Telegram settings saved"
      });
    }

    function saveSocialSettings(e){
      e.preventDefault();
      const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
      return saveSettingsDoc({
        docId: "social",
        payload: {
          facebook: get("commSocialFacebook"),
          instagram: get("commSocialInstagram"),
          tiktok: get("commSocialTiktok"),
          youtube: get("commSocialYoutube"),
          x: get("commSocialX"),
          linkedin: get("commSocialLinkedin"),
          discord: get("commSocialDiscord"),
          github: get("commSocialGithub")
        },
        btnId: "commSocialSubmitBtn",
        btnLabel: "Save Social Links",
        successTitle: "Social links saved"
      });
    }

    function saveFloatingContactSettings(e){
      e.preventDefault();
      const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
      return saveSettingsDoc({
        docId: "floatingContact",
        payload: {
          whatsappNumber: get("commFloatingWhatsappNumber"),
          telegramUsername: get("commFloatingTelegramUsername").replace(/^@/, "")
        },
        btnId: "commFloatingContactSubmitBtn",
        btnLabel: "Save Floating Buttons",
        successTitle: "Floating contact buttons saved"
      });
    }

    function bindCommunicationPage(){
      whatsappNumbersMgr.bind();
      whatsappGroupsMgr.bind();
      whatsappChannelsMgr.bind();
      telegramGroupsMgr.bind();
      telegramChannelsMgr.bind();
      telegramBotsMgr.bind();

      if (communicationBound) return;
      const bindForm = (id, handler) => {
        const form = document.getElementById(id);
        if (form && form.dataset.bound !== "true"){
          form.addEventListener("submit", handler);
          form.dataset.bound = "true";
        }
      };
      bindForm("commContactForm", saveContactInfo);
      bindForm("commWhatsappForm", saveWhatsappSettings);
      bindForm("commTelegramForm", saveTelegramSettings);
      bindForm("commSocialForm", saveSocialSettings);
      bindForm("commFloatingContactForm", saveFloatingContactSettings);
      communicationBound = true;
    }

    /** Entry point wired from handleRouteClick for data-route="admin-communication". */
    function renderCommunicationPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindCommunicationPage();
      loadCommunicationSettings();
    }

    /* ---------------------------------------------------------
       LEGAL PAGES EDITOR
       Five forms, ALL against ONE doc — settings/legal — in the
       top-level "settings" Firestore collection:
         { about, privacy, terms, refund, faq: [{q, a}, ...] }
       Each form saves only its own field(s) (merge:true), so
       saving the FAQ list never touches About/Privacy/Terms/Refund
       text and vice-versa. window.YF.legal (public, read-only
       mirror) subscribes to the same doc and re-applies it live to
       the public pages the instant a save succeeds here.
       --------------------------------------------------------- */

    // FAQ needs a multi-line textarea for the answer, so it gets its
    // own small manager (createListManager's rows are single-line
    // <input> only) rather than reusing that factory as-is.
    function createFaqManager(containerId, addBtnId){
      let items = [];

      function render(){
        const el = document.getElementById(containerId);
        if (!el) return;
        if (!items.length){
          el.innerHTML = `<div class="repeatable-list-empty">No questions yet — click "Add Question" above.</div>`;
          return;
        }
        el.innerHTML = items.map((it, idx) => `
          <div class="repeatable-row" data-idx="${idx}" style="flex-direction:column; align-items:stretch; gap:var(--sp-2);">
            <input class="form-input" type="text" placeholder="Question" data-field="q" value="${escapeHtml(it.q || "")}">
            <textarea class="form-input" rows="2" placeholder="Answer" data-field="a">${escapeHtml(it.a || "")}</textarea>
            <button type="button" class="repeatable-row__remove" data-remove="${idx}" aria-label="Remove" style="align-self:flex-end;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>`).join("");
      }

      function bind(){
        const el = document.getElementById(containerId);
        const addBtn = document.getElementById(addBtnId);
        if (el && el.dataset.bound !== "true"){
          el.addEventListener("input", (e) => {
            const row = e.target.closest(".repeatable-row");
            const field = e.target.dataset.field;
            if (!row || !field) return;
            const idx = Number(row.dataset.idx);
            if (items[idx]) items[idx][field] = e.target.value;
          });
          el.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-remove]");
            if (!btn) return;
            items.splice(Number(btn.dataset.remove), 1);
            render();
          });
          el.dataset.bound = "true";
        }
        if (addBtn && addBtn.dataset.bound !== "true"){
          addBtn.addEventListener("click", () => { items.push({ q: "", a: "" }); render(); });
          addBtn.dataset.bound = "true";
        }
      }

      return {
        setItems(arr){ items = Array.isArray(arr) ? arr.map(x => ({ q: x.q || "", a: x.a || "" })) : []; render(); },
        getItems(){ return items.filter(it => String(it.q || "").trim() !== "" || String(it.a || "").trim() !== ""); },
        bind
      };
    }

    const legalFaqMgr = createFaqManager("legalFaqManagerList", "legalFaqAddBtn");

    let legalBound = false;

    function loadLegalSettings(){
      const d = (window.YF.legal && window.YF.legal.getLegal()) || {};
      const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
      val("legalFormAbout", d.about);
      val("legalFormPrivacy", d.privacy);
      val("legalFormTerms", d.terms);
      val("legalFormRefund", d.refund);
      legalFaqMgr.setItems(d.faq);
    }

    function saveAboutPage(e){
      e.preventDefault();
      const el = document.getElementById("legalFormAbout");
      return saveSettingsDoc({
        docId: "legal",
        payload: { about: el ? el.value : "" },
        btnId: "legalAboutSubmitBtn",
        btnLabel: "Save About Page",
        successTitle: "About page saved"
      });
    }

    function savePrivacyPage(e){
      e.preventDefault();
      const el = document.getElementById("legalFormPrivacy");
      return saveSettingsDoc({
        docId: "legal",
        payload: { privacy: el ? el.value : "" },
        btnId: "legalPrivacySubmitBtn",
        btnLabel: "Save Privacy Policy",
        successTitle: "Privacy policy saved"
      });
    }

    function saveTermsPage(e){
      e.preventDefault();
      const el = document.getElementById("legalFormTerms");
      return saveSettingsDoc({
        docId: "legal",
        payload: { terms: el ? el.value : "" },
        btnId: "legalTermsSubmitBtn",
        btnLabel: "Save Terms",
        successTitle: "Terms saved"
      });
    }

    function saveRefundPage(e){
      e.preventDefault();
      const el = document.getElementById("legalFormRefund");
      return saveSettingsDoc({
        docId: "legal",
        payload: { refund: el ? el.value : "" },
        btnId: "legalRefundSubmitBtn",
        btnLabel: "Save Refund Policy",
        successTitle: "Refund policy saved"
      });
    }

    function saveFaqSettings(e){
      e.preventDefault();
      return saveSettingsDoc({
        docId: "legal",
        payload: { faq: legalFaqMgr.getItems() },
        btnId: "legalFaqSubmitBtn",
        btnLabel: "Save FAQ",
        successTitle: "FAQ saved"
      });
    }

    function bindLegalPage(){
      legalFaqMgr.bind();
      if (window.YF.legal) window.YF.legal.onUpdate(() => {
        if (!document.getElementById("page-admin-legal").classList.contains("u-hidden")) loadLegalSettings();
      });

      if (legalBound) return;
      const bindForm = (id, handler) => {
        const form = document.getElementById(id);
        if (form && form.dataset.bound !== "true"){
          form.addEventListener("submit", handler);
          form.dataset.bound = "true";
        }
      };
      bindForm("legalAboutForm", saveAboutPage);
      bindForm("legalPrivacyForm", savePrivacyPage);
      bindForm("legalTermsForm", saveTermsPage);
      bindForm("legalRefundForm", saveRefundPage);
      bindForm("legalFaqForm", saveFaqSettings);
      legalBound = true;
    }

    /** Entry point wired from handleRouteClick for data-route="admin-legal". */
    function renderLegalPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindLegalPage();
      loadLegalSettings();
    }

    /* ---------------------------------------------------------
       COUPONS MANAGER
       Full CRUD against a top-level "coupons" Firestore collection.
       Doc id = the uppercased coupon code, guaranteeing uniqueness
       without a separate lookup. Matching Firestore security rule:
         match /coupons/{code} {
           allow read: if request.auth != null;
           allow write: if request.auth != null && isAdmin();
         }
       --------------------------------------------------------- */
    function couponStatusOf(c){
      if (c.active === false) return "disabled";
      if (c.expiresAt){
        const expMs = (c.expiresAt && c.expiresAt.toMillis) ? c.expiresAt.toMillis() : new Date(c.expiresAt).getTime();
        if (expMs && Date.now() > expMs) return "expired";
      }
      return "active";
    }

    function couponStatusBadge(status){
      const map = {
        active:   { cls:"status-badge--active",   label:"Active" },
        disabled: { cls:"status-badge--revoked",   label:"Disabled" },
        expired:  { cls:"status-badge--expired",   label:"Expired" }
      };
      const m = map[status] || map.active;
      return `<span class="status-badge ${m.cls}">${m.label}</span>`;
    }

    function subscribeCoupons(){
      const fb = window.YF.firebase;
      if (couponsUnsub){ try{ couponsUnsub(); }catch(e){} couponsUnsub = null; }
      if (!(fb && fb.db && fb.collection && fb.onSnapshot)){
        couponsCache = [];
        renderCouponsTable();
        return;
      }
      try{
        couponsUnsub = fb.onSnapshot(fb.collection(fb.db, "coupons"), (snap) => {
          couponsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => {
              const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
              const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
              return bt - at;
            });
          renderCouponsTable();
        }, (err) => {
          console.error("YF.admin: coupons onSnapshot error", err);
          renderCouponsTable();
        });
      }catch(err){
        console.error("YF.admin: subscribeCoupons failed", err);
        renderCouponsTable();
      }
    }

    function couponExpiryLabel(c){
      if (!c.expiresAt) return "Never";
      const ms = (c.expiresAt && c.expiresAt.toMillis) ? c.expiresAt.toMillis() : new Date(c.expiresAt).getTime();
      if (!ms) return "Never";
      return new Date(ms).toLocaleDateString();
    }

    function renderCouponsTable(){
      const tbody = document.getElementById("adminCouponsTableBody");
      if (!tbody) return;
      const q = couponSearch.trim().toLowerCase();
      const list = couponsCache.filter(c => {
        if (q && !String(c.id).toLowerCase().includes(q)) return false;
        if (couponStatusFilter !== "all" && couponStatusOf(c) !== couponStatusFilter) return false;
        return true;
      });
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="7"><div class="admin-empty-state">${
          couponsCache.length ? "No coupons match your search/filter." : "No coupons yet — create your first discount code."
        }</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(c => {
        const status = couponStatusOf(c);
        const discount = c.type === "fixed" ? `$${Number(c.value || 0).toFixed(2)} off` : `${Number(c.value || 0)}% off`;
        const maxUses = Number(c.maxUses) || 0;
        const used = Number(c.usedCount) || 0;
        return `
        <tr data-coupon-row="${c.id}">
          <td class="product-row__title">${escapeHtml(c.id)}</td>
          <td>${escapeHtml(discount)}</td>
          <td>${c.minOrder ? formatPrice(c.minOrder) : "—"}</td>
          <td>${used}${maxUses ? " / " + maxUses : " / ∞"}</td>
          <td class="u-text-muted">${couponExpiryLabel(c)}</td>
          <td>${couponStatusBadge(status)}</td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-coupon="${c.id}">Edit</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-coupon="${c.id}">Delete</button>
            </div>
          </td>
        </tr>
      `; }).join("");
    }

    function openCouponForm(mode, couponId){
      const form = document.getElementById("couponForm");
      const title = document.getElementById("couponFormModalTitle");
      const codeInput = document.getElementById("couponFormCode");
      form.reset();
      document.getElementById("couponFormMode").value = mode;
      document.getElementById("couponFormOrigId").value = "";
      if (mode === "edit"){
        const c = couponsCache.find(x => x.id === couponId);
        if (!c) return;
        document.getElementById("couponFormOrigId").value = c.id;
        codeInput.value = c.id;
        codeInput.disabled = true;
        document.getElementById("couponFormType").value = c.type || "percent";
        document.getElementById("couponFormValue").value = c.value != null ? c.value : "";
        document.getElementById("couponFormMinOrder").value = c.minOrder != null ? c.minOrder : "";
        document.getElementById("couponFormMaxUses").value = Number(c.maxUses) || 0;
        document.getElementById("couponFormPerUserLimit").value = c.perUserLimit != null ? Number(c.perUserLimit) : 1;
        const expMs = c.expiresAt ? ((c.expiresAt.toMillis) ? c.expiresAt.toMillis() : new Date(c.expiresAt).getTime()) : null;
        document.getElementById("couponFormExpiry").value = expMs ? new Date(expMs).toISOString().slice(0, 10) : "";
        document.getElementById("couponFormActive").checked = c.active !== false;
        title.textContent = "Edit Coupon";
      } else {
        codeInput.disabled = false;
        document.getElementById("couponFormPerUserLimit").value = 1;
        document.getElementById("couponFormActive").checked = true;
        title.textContent = "New Coupon";
      }
      window.YF.ui.openModal("couponFormModal");
    }

    async function saveCoupon(e){
      e.preventDefault();
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const mode = document.getElementById("couponFormMode").value;
      const origId = document.getElementById("couponFormOrigId").value;
      const code = document.getElementById("couponFormCode").value.trim().toUpperCase();
      const value = Number(document.getElementById("couponFormValue").value) || 0;
      if (!code || value <= 0){
        window.YF.ui.toast({ type:"danger", title:"Missing details", message:"Please provide a code and a discount value greater than 0." });
        return;
      }
      const minOrderRaw = document.getElementById("couponFormMinOrder").value;
      const expiryRaw = document.getElementById("couponFormExpiry").value;
      const payload = {
        type: document.getElementById("couponFormType").value,
        value,
        minOrder: minOrderRaw ? Number(minOrderRaw) : null,
        maxUses: Number(document.getElementById("couponFormMaxUses").value) || 0,
        perUserLimit: Number(document.getElementById("couponFormPerUserLimit").value) || 0,
        expiresAt: expiryRaw ? new Date(expiryRaw + "T23:59:59") : null,
        active: document.getElementById("couponFormActive").checked
      };
      const btn = document.getElementById("couponFormSubmitBtn");
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        if (mode === "edit"){
          await fb.updateDoc(fb.doc(fb.db, "coupons", origId), { ...payload, updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Coupon updated", message:`"${code}" was saved.` });
          logActivity("coupon-update", `Updated coupon "${code}"`);
        } else {
          if (couponsCache.some(c => c.id === code)) throw new Error(`A coupon with code "${code}" already exists.`);
          await fb.setDoc(fb.doc(fb.db, "coupons", code), {
            ...payload, usedCount: 0, createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
          });
          window.YF.ui.toast({ type:"success", title:"Coupon created", message:`"${code}" was added.` });
          logActivity("coupon-create", `Created coupon "${code}"`);
        }
        window.YF.ui.closeModal("couponFormModal");
      }catch(err){
        console.error("YF.admin: saveCoupon failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save coupon", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Coupon";
      }
    }

    function confirmDeleteCoupon(couponId){
      const c = couponsCache.find(x => x.id === couponId);
      if (!c) return;
      document.getElementById("deleteCouponId").value = couponId;
      document.getElementById("deleteCouponLabel").textContent = c.id;
      window.YF.ui.openModal("deleteCouponModal");
    }

    async function performDeleteCoupon(){
      if (!isAdmin()) return;
      const fb = window.YF.firebase;
      const id = document.getElementById("deleteCouponId").value;
      if (!id) return;
      const btn = document.getElementById("confirmDeleteCouponBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        await fb.deleteDoc(fb.doc(fb.db, "coupons", id));
        window.YF.ui.toast({ type:"info", title:"Coupon deleted", message:"The coupon was permanently removed." });
        logActivity("coupon-delete", `Deleted coupon "${id}"`);
        window.YF.ui.closeModal("deleteCouponModal");
      }catch(err){
        console.error("YF.admin: deleteCoupon failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete coupon", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    let couponsBound = false;
    function bindCouponsPage(){
      if (couponsBound) return;
      const tbody = document.getElementById("adminCouponsTableBody");
      if (tbody){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-coupon]");
          const delBtn = e.target.closest("[data-delete-coupon]");
          if (editBtn) openCouponForm("edit", editBtn.dataset.editCoupon);
          if (delBtn) confirmDeleteCoupon(delBtn.dataset.deleteCoupon);
        });
      }
      const newBtn = document.getElementById("adminNewCouponBtn");
      if (newBtn) newBtn.addEventListener("click", () => openCouponForm("create"));
      const form = document.getElementById("couponForm");
      if (form) form.addEventListener("submit", saveCoupon);
      const confirmDelBtn = document.getElementById("confirmDeleteCouponBtn");
      if (confirmDelBtn) confirmDelBtn.addEventListener("click", performDeleteCoupon);
      const searchInput = document.getElementById("adminCouponSearch");
      if (searchInput) searchInput.addEventListener("input", (e) => { couponSearch = e.target.value; renderCouponsTable(); });
      const statusFilter = document.getElementById("adminCouponStatusFilter");
      if (statusFilter) statusFilter.addEventListener("change", (e) => { couponStatusFilter = e.target.value; renderCouponsTable(); });
      couponsBound = true;
    }

    /** Entry point wired from handleRouteClick for data-route="admin-coupons". */
    function renderCouponsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindCouponsPage();
      if (!couponsUnsub) subscribeCoupons(); else renderCouponsTable();
    }

    /* ---------------------------------------------------------
       ANNOUNCEMENTS MANAGER
       Full CRUD against a top-level "announcements" Firestore
       collection. The public, read-only YF.announcements module
       (registered next to YF.siteSettings/YF.legal) subscribes to
       this same collection and renders active docs as a banner
       (type:"banner") above the navbar or a popup (type:"popup").
       Matching Firestore security rule:
         match /announcements/{id} {
           allow read: if true;
           allow write: if request.auth != null && isAdmin();
         }
       --------------------------------------------------------- */
    function subscribeAnnouncements(){
      const fb = window.YF.firebase;
      if (announcementsUnsub){ try{ announcementsUnsub(); }catch(e){} announcementsUnsub = null; }
      if (!(fb && fb.db && fb.collection && fb.onSnapshot)){
        announcementsCache = [];
        renderAnnouncementsTable();
        return;
      }
      try{
        announcementsUnsub = fb.onSnapshot(fb.collection(fb.db, "announcements"), (snap) => {
          announcementsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => {
              const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
              const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
              return bt - at;
            });
          renderAnnouncementsTable();
        }, (err) => {
          console.error("YF.admin: announcements onSnapshot error", err);
          renderAnnouncementsTable();
        });
      }catch(err){
        console.error("YF.admin: subscribeAnnouncements failed", err);
        renderAnnouncementsTable();
      }
    }

    function announcementDateLabel(a){
      const ms = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : (typeof a.createdAt === "number" ? a.createdAt : 0);
      return ms ? new Date(ms).toLocaleDateString() : "—";
    }

    function renderAnnouncementsTable(){
      const tbody = document.getElementById("adminAnnouncementsTableBody");
      if (!tbody) return;
      const q = announcementSearch.trim().toLowerCase();
      const list = announcementsCache.filter(a => {
        if (q && !String(a.title || "").toLowerCase().includes(q) && !String(a.message || "").toLowerCase().includes(q)) return false;
        if (announcementTypeFilter !== "all" && (a.type || "banner") !== announcementTypeFilter) return false;
        return true;
      });
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="6"><div class="admin-empty-state">${
          announcementsCache.length ? "No announcements match your search/filter." : "No announcements yet — create your first banner or popup."
        }</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(a => `
        <tr data-announcement-row="${a.id}">
          <td class="product-row__title">${escapeHtml(a.title || "Untitled")}</td>
          <td>${a.type === "popup" ? "Popup" : "Banner"}</td>
          <td style="text-transform:capitalize;">${escapeHtml(a.style || "gold")}</td>
          <td>${a.active === false ? `<span class="status-badge status-badge--revoked">Inactive</span>` : `<span class="status-badge status-badge--active">Active</span>`}</td>
          <td class="u-text-muted">${announcementDateLabel(a)}</td>
          <td>
            <div class="admin-row-actions">
              <button type="button" class="admin-action-btn" data-edit-announcement="${a.id}">Edit</button>
              <button type="button" class="admin-action-btn admin-action-btn--danger" data-delete-announcement="${a.id}">Delete</button>
            </div>
          </td>
        </tr>
      `).join("");
    }

    function openAnnouncementForm(mode, announcementId){
      const form = document.getElementById("announcementForm");
      const title = document.getElementById("announcementFormModalTitle");
      form.reset();
      document.getElementById("announcementFormId").value = "";
      if (mode === "edit"){
        const a = announcementsCache.find(x => x.id === announcementId);
        if (!a) return;
        document.getElementById("announcementFormId").value = a.id;
        document.getElementById("announcementFormTitle").value = a.title || "";
        document.getElementById("announcementFormMessage").value = a.message || "";
        document.getElementById("announcementFormType").value = a.type || "banner";
        document.getElementById("announcementFormStyle").value = a.style || "gold";
        document.getElementById("announcementFormActive").checked = a.active !== false;
        title.textContent = "Edit Announcement";
      } else {
        document.getElementById("announcementFormActive").checked = true;
        title.textContent = "New Announcement";
      }
      window.YF.ui.openModal("announcementFormModal");
    }

    async function saveAnnouncement(e){
      e.preventDefault();
      if (!isAdmin()){
        window.YF.ui.toast({ type:"danger", title:"Admins only", message:"You don't have permission to do this." });
        return;
      }
      const fb = window.YF.firebase;
      const id = document.getElementById("announcementFormId").value;
      const payload = {
        title: document.getElementById("announcementFormTitle").value.trim(),
        message: document.getElementById("announcementFormMessage").value.trim(),
        type: document.getElementById("announcementFormType").value,
        style: document.getElementById("announcementFormStyle").value,
        active: document.getElementById("announcementFormActive").checked
      };
      if (!payload.title || !payload.message){
        window.YF.ui.toast({ type:"danger", title:"Missing details", message:"Please provide a title and message." });
        return;
      }
      const btn = document.getElementById("announcementFormSubmitBtn");
      btn.disabled = true; btn.textContent = "Saving…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        if (id){
          await fb.updateDoc(fb.doc(fb.db, "announcements", id), { ...payload, updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Announcement updated", message:`"${payload.title}" was saved.` });
          logActivity("announcement-update", `Updated announcement "${payload.title}"`);
        } else {
          await fb.addDoc(fb.collection(fb.db, "announcements"), { ...payload, createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp() });
          window.YF.ui.toast({ type:"success", title:"Announcement created", message:`"${payload.title}" was added.` });
          logActivity("announcement-create", `Created announcement "${payload.title}"`);
        }
        window.YF.ui.closeModal("announcementFormModal");
      }catch(err){
        console.error("YF.admin: saveAnnouncement failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't save announcement", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Save Announcement";
      }
    }

    function confirmDeleteAnnouncement(announcementId){
      const a = announcementsCache.find(x => x.id === announcementId);
      if (!a) return;
      document.getElementById("deleteAnnouncementId").value = announcementId;
      document.getElementById("deleteAnnouncementLabel").textContent = a.title || "this announcement";
      window.YF.ui.openModal("deleteAnnouncementModal");
    }

    async function performDeleteAnnouncement(){
      if (!isAdmin()) return;
      const fb = window.YF.firebase;
      const id = document.getElementById("deleteAnnouncementId").value;
      if (!id) return;
      const btn = document.getElementById("confirmDeleteAnnouncementBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try{
        if (!(fb && fb.db)) throw new Error("Firestore isn't available in this environment.");
        const a = announcementsCache.find(x => x.id === id);
        await fb.deleteDoc(fb.doc(fb.db, "announcements", id));
        window.YF.ui.toast({ type:"info", title:"Announcement deleted", message:"It was permanently removed." });
        logActivity("announcement-delete", `Deleted announcement "${(a && a.title) || id}"`);
        window.YF.ui.closeModal("deleteAnnouncementModal");
      }catch(err){
        console.error("YF.admin: deleteAnnouncement failed", err);
        window.YF.ui.toast({ type:"danger", title:"Couldn't delete announcement", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Delete Permanently";
      }
    }

    let announcementsBound = false;
    function bindAnnouncementsPage(){
      if (announcementsBound) return;
      const tbody = document.getElementById("adminAnnouncementsTableBody");
      if (tbody){
        tbody.addEventListener("click", (e) => {
          const editBtn = e.target.closest("[data-edit-announcement]");
          const delBtn = e.target.closest("[data-delete-announcement]");
          if (editBtn) openAnnouncementForm("edit", editBtn.dataset.editAnnouncement);
          if (delBtn) confirmDeleteAnnouncement(delBtn.dataset.deleteAnnouncement);
        });
      }
      const newBtn = document.getElementById("adminNewAnnouncementBtn");
      if (newBtn) newBtn.addEventListener("click", () => openAnnouncementForm("create"));
      const form = document.getElementById("announcementForm");
      if (form) form.addEventListener("submit", saveAnnouncement);
      const confirmDelBtn = document.getElementById("confirmDeleteAnnouncementBtn");
      if (confirmDelBtn) confirmDelBtn.addEventListener("click", performDeleteAnnouncement);
      const searchInput = document.getElementById("adminAnnouncementSearch");
      if (searchInput) searchInput.addEventListener("input", (e) => { announcementSearch = e.target.value; renderAnnouncementsTable(); });
      const typeFilter = document.getElementById("adminAnnouncementTypeFilter");
      if (typeFilter) typeFilter.addEventListener("change", (e) => { announcementTypeFilter = e.target.value; renderAnnouncementsTable(); });
      announcementsBound = true;
    }

    /** Entry point wired from handleRouteClick for data-route="admin-announcements". */
    function renderAnnouncementsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindAnnouncementsPage();
      if (!announcementsUnsub) subscribeAnnouncements(); else renderAnnouncementsTable();
    }

    /* ---------------------------------------------------------
       NOTIFICATION TEMPLATES EDITOR
       One singleton doc, settings/notificationTemplates, edited the
       same way Site Settings / Communication / Legal already are —
       via the shared saveSettingsDoc() helper. The public
       YF.notifyTemplates module (registered next to YF.siteSettings)
       reads this same document to render the actual notification
       text sent by YF.orders / YF.licenses.
       --------------------------------------------------------- */
    async function loadNotificationTemplates(){
      const fb = window.YF.firebase;
      if (!(fb && fb.db)) return;
      try{
        const snap = await fb.getDoc(fb.doc(fb.db, "settings", "notificationTemplates"));
        const t = snap.exists() ? snap.data() : {};
        const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? "" : v; };
        val("notifyTplOrderApprovedTitle", t.orderApprovedTitle);
        val("notifyTplOrderApprovedMessage", t.orderApprovedMessage);
        val("notifyTplOrderRejectedTitle", t.orderRejectedTitle);
        val("notifyTplOrderRejectedMessage", t.orderRejectedMessage);
        val("notifyTplPaymentRefundedTitle", t.paymentRefundedTitle);
        val("notifyTplPaymentRefundedMessage", t.paymentRefundedMessage);
        val("notifyTplLicenseIssuedTitle", t.licenseIssuedTitle);
        val("notifyTplLicenseIssuedMessage", t.licenseIssuedMessage);
        val("notifyTplLicenseRevokedTitle", t.licenseRevokedTitle);
        val("notifyTplLicenseRevokedMessage", t.licenseRevokedMessage);
      }catch(err){
        console.error("YF.admin: loading settings/notificationTemplates failed", err);
      }
    }

    function saveNotificationTemplates(e){
      e.preventDefault();
      const get = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
      return saveSettingsDoc({
        docId: "notificationTemplates",
        payload: {
          orderApprovedTitle: get("notifyTplOrderApprovedTitle"),
          orderApprovedMessage: get("notifyTplOrderApprovedMessage"),
          orderRejectedTitle: get("notifyTplOrderRejectedTitle"),
          orderRejectedMessage: get("notifyTplOrderRejectedMessage"),
          paymentRefundedTitle: get("notifyTplPaymentRefundedTitle"),
          paymentRefundedMessage: get("notifyTplPaymentRefundedMessage"),
          licenseIssuedTitle: get("notifyTplLicenseIssuedTitle"),
          licenseIssuedMessage: get("notifyTplLicenseIssuedMessage"),
          licenseRevokedTitle: get("notifyTplLicenseRevokedTitle"),
          licenseRevokedMessage: get("notifyTplLicenseRevokedMessage")
        },
        btnId: "notifyTemplatesSubmitBtn",
        btnLabel: "Save Templates",
        successTitle: "Notification templates updated"
      });
    }

    function bindNotificationTemplatesPage(){
      if (notifyTemplatesBound) return;
      const form = document.getElementById("notifyTemplatesForm");
      if (form) form.addEventListener("submit", saveNotificationTemplates);
      const broadcastForm = document.getElementById("broadcastForm");
      if (broadcastForm) broadcastForm.addEventListener("submit", sendBroadcast);
      notifyTemplatesBound = true;
    }

    async function sendBroadcast(e){
      e.preventDefault();
      const btn = document.getElementById("broadcastSubmitBtn");
      const title = document.getElementById("broadcastTitle").value;
      const message = document.getElementById("broadcastMessage").value;
      const type = document.getElementById("broadcastType").value;
      btn.disabled = true; btn.textContent = "Sending…";
      try{
        const count = await window.YF.notifications.adminBroadcast({ title, message, type });
        window.YF.ui.toast({ type:"success", title:"Broadcast sent", message:`Delivered to ${count} user${count === 1 ? "" : "s"}.` });
        document.getElementById("broadcastForm").reset();
      }catch(err){
        window.YF.ui.toast({ type:"danger", title:"Couldn't send broadcast", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Send to All Users";
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-notification-templates". */
    function renderNotificationTemplatesPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindNotificationTemplatesPage();
      loadNotificationTemplates();
    }

    /* ---------------------------------------------------------
       ACTIVITY LOGS (AUDIT TRAIL) — read-only viewer
       Reads the top-level "activityLogs" collection every other
       admin-mutating function in this module writes to via
       logActivity(). Newest first, capped client-side to the most
       recent 300 entries so a long-running store never balloons the
       page. Matching Firestore security rule:
         match /activityLogs/{id} {
           allow read: if request.auth != null && isAdmin();
           allow create: if request.auth != null && isAdmin()
             && request.resource.data.adminUid == request.auth.uid;
           allow update, delete: if false;
         }
       --------------------------------------------------------- */
    function subscribeActivityLogs(){
      const fb = window.YF.firebase;
      if (activityLogsUnsub){ try{ activityLogsUnsub(); }catch(e){} activityLogsUnsub = null; }
      if (!(fb && fb.db && fb.collection && fb.onSnapshot)){
        activityLogsCache = [];
        renderActivityLogsTable();
        return;
      }
      try{
        activityLogsUnsub = fb.onSnapshot(fb.collection(fb.db, "activityLogs"), (snap) => {
          activityLogsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => {
              const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
              const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
              return bt - at;
            })
            .slice(0, 300);
          populateActivityLogActionFilter();
          renderActivityLogsTable();
        }, (err) => {
          console.error("YF.admin: activityLogs onSnapshot error", err);
          renderActivityLogsTable();
        });
      }catch(err){
        console.error("YF.admin: subscribeActivityLogs failed", err);
        renderActivityLogsTable();
      }
    }

    function populateActivityLogActionFilter(){
      const sel = document.getElementById("adminActivityLogActionFilter");
      if (!sel) return;
      const prev = sel.value;
      const actions = Array.from(new Set(activityLogsCache.map(l => l.action).filter(Boolean))).sort();
      sel.innerHTML = `<option value="all">All actions</option>` + actions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
      if (actions.includes(prev)) sel.value = prev;
    }

    function activityLogDateLabel(l){
      const ms = (l.createdAt && l.createdAt.toMillis) ? l.createdAt.toMillis() : (typeof l.createdAt === "number" ? l.createdAt : 0);
      return ms ? new Date(ms).toLocaleString() : "—";
    }

    function renderActivityLogsTable(){
      const tbody = document.getElementById("adminActivityLogsTableBody");
      if (!tbody) return;
      const q = activityLogSearch.trim().toLowerCase();
      const list = activityLogsCache.filter(l => {
        if (activityLogActionFilter !== "all" && l.action !== activityLogActionFilter) return false;
        if (q && !String(l.adminEmail || "").toLowerCase().includes(q)
              && !String(l.adminName || "").toLowerCase().includes(q)
              && !String(l.action || "").toLowerCase().includes(q)
              && !String(l.detail || "").toLowerCase().includes(q)) return false;
        return true;
      });
      if (!list.length){
        tbody.innerHTML = `<tr><td colspan="4"><div class="admin-empty-state">${
          activityLogsCache.length ? "No log entries match your search/filter." : "No admin activity recorded yet — actions taken across the panel will appear here."
        }</div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(l => `
        <tr>
          <td class="product-row__title">${escapeHtml(l.adminName || l.adminEmail || l.adminUid || "Unknown admin")}</td>
          <td><span class="category-id-chip">${escapeHtml(l.action || "unknown")}</span></td>
          <td class="u-text-muted">${escapeHtml(l.detail || "")}</td>
          <td class="u-text-muted">${activityLogDateLabel(l)}</td>
        </tr>
      `).join("");
    }

    let activityLogsBound = false;
    function bindActivityLogsPage(){
      if (activityLogsBound) return;
      const searchInput = document.getElementById("adminActivityLogSearch");
      if (searchInput) searchInput.addEventListener("input", (e) => { activityLogSearch = e.target.value; renderActivityLogsTable(); });
      const actionFilter = document.getElementById("adminActivityLogActionFilter");
      if (actionFilter) actionFilter.addEventListener("change", (e) => { activityLogActionFilter = e.target.value; renderActivityLogsTable(); });
      activityLogsBound = true;
    }

    /** Entry point wired from handleRouteClick for data-route="admin-activity-logs". */
    function renderActivityLogsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindActivityLogsPage();
      if (!activityLogsUnsub) subscribeActivityLogs(); else renderActivityLogsTable();
    }

    /* ---------------------------------------------------------
       REPORTS (Phase G)
       Pulls live data straight from Firestore into a preview table,
       then exports it three ways — all client-side:
         CSV    — built by hand (no library needed)
         Excel  — SheetJS (window.XLSX, loaded via CDN <script> tag)
         PDF    — jsPDF + autoTable (window.jspdf, loaded via CDN)
       --------------------------------------------------------- */
    let currentReportColumns = [];
    let currentReportRows = [];
    let currentReportName = "report";

    function reportCutoffMs(){
      const range = document.getElementById("reportRangeSelect").value;
      if (range === "all") return 0;
      return Date.now() - Number(range) * 86400000;
    }

    function tsToMs(ts){
      if (!ts) return 0;
      if (ts.toMillis) return ts.toMillis();
      const n = new Date(ts).getTime();
      return Number.isFinite(n) ? n : 0;
    }

    async function buildSalesReport(cutoff){
      const fb = window.YF.firebase;
      const snap = await fb.getDocs(fb.collection(fb.db, "orders"));
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(o => o.status === "approved" && tsToMs(o.createdAt) >= cutoff)
        .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
        .map(o => ({
          Date: tsToMs(o.createdAt) ? new Date(tsToMs(o.createdAt)).toLocaleDateString() : "",
          Buyer: o.buyerEmail || o.buyerName || "",
          Product: o.productTitle || "",
          Amount: Number(o.amount) || 0,
          "Payment Method": o.paymentMethodLabel || o.paymentMethodId || ""
        }));
      return rows;
    }

    async function buildOrdersReport(cutoff){
      const fb = window.YF.firebase;
      const snap = await fb.getDocs(fb.collection(fb.db, "orders"));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(o => tsToMs(o.createdAt) >= cutoff)
        .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
        .map(o => ({
          Date: tsToMs(o.createdAt) ? new Date(tsToMs(o.createdAt)).toLocaleDateString() : "",
          Buyer: o.buyerEmail || o.buyerName || "",
          Product: o.productTitle || "",
          Amount: Number(o.amount) || 0,
          Status: o.status || "pending"
        }));
    }

    async function buildRevenueReport(cutoff){
      const fb = window.YF.firebase;
      const snap = await fb.getDocs(fb.collection(fb.db, "orders"));
      const approved = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(o => o.status === "approved" && tsToMs(o.createdAt) >= cutoff);
      const byMonth = {};
      approved.forEach(o => {
        const ms = tsToMs(o.createdAt);
        if (!ms) return;
        const d = new Date(ms);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!byMonth[key]) byMonth[key] = { Month: key, Revenue: 0, Orders: 0 };
        byMonth[key].Revenue += Number(o.amount) || 0;
        byMonth[key].Orders += 1;
      });
      return Object.values(byMonth).sort((a, b) => b.Month.localeCompare(a.Month));
    }

    async function buildProductsReport(){
      const fb = window.YF.firebase;
      const snap = await fb.getDocs(fb.collection(fb.db, "products"));
      return snap.docs.map(d => ({ id: d.id, ...d.data() })).map(p => ({
        Title: p.title || "", Category: p.category || "", Price: Number(p.price) || 0,
        Status: p.status || "draft", Sales: Number(p.sales) || 0
      }));
    }

    async function buildUsersReport(){
      const fb = window.YF.firebase;
      const snap = await fb.getDocs(fb.collection(fb.db, "users"));
      return snap.docs.map(d => ({ id: d.id, ...d.data() })).map(u => ({
        Name: u.name || "", Email: u.email || "", Role: u.role || "user",
        Status: u.status || "active", Joined: tsToMs(u.createdAt) ? new Date(tsToMs(u.createdAt)).toLocaleDateString() : ""
      }));
    }

    function renderReportPreview(){
      const table = document.getElementById("reportPreviewTable");
      if (!currentReportRows.length){
        table.innerHTML = `<thead><tr><th class="u-text-muted">No data for this report/range.</th></tr></thead><tbody></tbody>`;
        return;
      }
      currentReportColumns = Object.keys(currentReportRows[0]);
      const preview = currentReportRows.slice(0, 50);
      table.innerHTML = `
        <thead><tr>${currentReportColumns.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${preview.map(row => `<tr>${currentReportColumns.map(c => `<td>${escapeHtml(String(row[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>`;
      if (currentReportRows.length > 50){
        table.querySelector("tbody").insertAdjacentHTML("beforeend", `<tr><td colspan="${currentReportColumns.length}" class="u-text-muted">…and ${currentReportRows.length - 50} more rows (included in the downloaded file).</td></tr>`);
      }
    }

    async function generateReport(){
      const type = document.getElementById("reportTypeSelect").value;
      const btn = document.getElementById("generateReportBtn");
      btn.disabled = true; btn.textContent = "Generating…";
      try{
        const cutoff = reportCutoffMs();
        currentReportName = type;
        if (type === "sales") currentReportRows = await buildSalesReport(cutoff);
        else if (type === "orders") currentReportRows = await buildOrdersReport(cutoff);
        else if (type === "revenue") currentReportRows = await buildRevenueReport(cutoff);
        else if (type === "products") currentReportRows = await buildProductsReport();
        else if (type === "users") currentReportRows = await buildUsersReport();
        renderReportPreview();
        document.getElementById("reportDownloadRow").style.display = currentReportRows.length ? "" : "none";
        logActivity("report_generate", `Generated ${type} report (${currentReportRows.length} rows)`);
      }catch(err){
        window.YF.ui.toast({ type:"danger", title:"Couldn't generate report", message: err.message || "Please try again." });
      }finally{
        btn.disabled = false; btn.textContent = "Generate Report";
      }
    }

    function csvEscape(val){
      const s = String(val ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    function downloadBlob(blob, filename){
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }

    function downloadReportCsv(){
      if (!currentReportRows.length) return;
      const cols = currentReportColumns;
      const lines = [cols.join(","), ...currentReportRows.map(r => cols.map(c => csvEscape(r[c])).join(","))];
      downloadBlob(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" }), `${currentReportName}-report.csv`);
    }

    function downloadReportExcel(){
      if (!currentReportRows.length) return;
      if (!window.XLSX){
        window.YF.ui.toast({ type:"danger", title:"Excel export unavailable", message:"The Excel export library didn't load — check your internet connection and try again." });
        return;
      }
      const ws = window.XLSX.utils.json_to_sheet(currentReportRows);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Report");
      window.XLSX.writeFile(wb, `${currentReportName}-report.xlsx`);
    }

    function downloadReportPdf(){
      if (!currentReportRows.length) return;
      if (!(window.jspdf && window.jspdf.jsPDF)){
        window.YF.ui.toast({ type:"danger", title:"PDF export unavailable", message:"The PDF export library didn't load — check your internet connection and try again." });
        return;
      }
      const doc = new window.jspdf.jsPDF();
      doc.setFontSize(14);
      doc.text(`${currentReportName.charAt(0).toUpperCase() + currentReportName.slice(1)} Report`, 14, 16);
      doc.autoTable({
        startY: 22,
        head: [currentReportColumns],
        body: currentReportRows.map(r => currentReportColumns.map(c => String(r[c] ?? ""))),
        styles: { fontSize: 8 }
      });
      doc.save(`${currentReportName}-report.pdf`);
    }

    let reportsBound = false;
    function bindReportsPage(){
      if (reportsBound) return;
      reportsBound = true;
      document.getElementById("generateReportBtn").addEventListener("click", generateReport);
      document.getElementById("downloadReportCsvBtn").addEventListener("click", downloadReportCsv);
      document.getElementById("downloadReportExcelBtn").addEventListener("click", downloadReportExcel);
      document.getElementById("downloadReportPdfBtn").addEventListener("click", downloadReportPdf);
    }

    /** Entry point wired from handleRouteClick for data-route="admin-reports". */
    function renderReportsPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindReportsPage();
    }

    /* ---------------------------------------------------------
       BACKUP / RESTORE (Phase G)
       Export reads whichever collections are checked and downloads
       one JSON file: { collectionName: [{ id, ...fields }] }.
       Restore reads an uploaded file of that SAME shape and MERGES
       every record back in (setDoc with merge:true, upserted by its
       own id) — deliberately never a delete-everything-first wipe,
       so a bad or partial backup file can't wholesale destroy data.
       --------------------------------------------------------- */
    async function exportCollectionsBackup(names){
      const fb = window.YF.firebase;
      const payload = {};
      for (const name of names){
        const snap = await fb.getDocs(fb.collection(fb.db, name));
        payload[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
      const filename = `youforge-backup-${new Date().toISOString().slice(0, 10)}.json`;
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename);
      logActivity("backup_export", `Exported backup: ${names.join(", ")}`);
      return payload;
    }

    function renderRestorePreview(data){
      const el = document.getElementById("restorePreview");
      const entries = Object.entries(data || {});
      if (!entries.length){ el.innerHTML = `<p class="u-text-muted">This file has no recognizable collections.</p>`; return; }
      el.innerHTML = `<ul style="margin:0; padding-left:1.2em;">${entries.map(([name, rows]) => `<li>${escapeHtml(name)}: ${Array.isArray(rows) ? rows.length : 0} record(s)</li>`).join("")}</ul>`;
    }

    let pendingRestoreData = null;

    function bindBackupPage(){
      const exportBtn = document.getElementById("exportBackupBtn");
      if (exportBtn && exportBtn.dataset.bound !== "true"){
        exportBtn.dataset.bound = "true";
        exportBtn.addEventListener("click", async () => {
          const checked = Array.from(document.querySelectorAll("#backupCollectionCheckboxes input:checked")).map(c => c.value);
          if (!checked.length){ window.YF.ui.toast({ type:"info", title:"Nothing selected", message:"Check at least one collection to export." }); return; }
          exportBtn.disabled = true; exportBtn.textContent = "Exporting…";
          try{ await exportCollectionsBackup(checked); window.YF.ui.toast({ type:"success", title:"Backup exported" }); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Export failed", message: err.message || "Please try again." }); }
          finally{ exportBtn.disabled = false; exportBtn.textContent = "Export Selected as JSON"; }
        });
      }
      const quickBtn = document.getElementById("exportProductsOnlyBtn");
      if (quickBtn && quickBtn.dataset.bound !== "true"){
        quickBtn.dataset.bound = "true";
        quickBtn.addEventListener("click", async () => {
          quickBtn.disabled = true;
          try{ await exportCollectionsBackup(["products"]); window.YF.ui.toast({ type:"success", title:"Products exported" }); }
          catch(err){ window.YF.ui.toast({ type:"danger", title:"Export failed", message: err.message || "Please try again." }); }
          finally{ quickBtn.disabled = false; }
        });
      }
      const fileInput = document.getElementById("restoreBackupFile");
      if (fileInput && fileInput.dataset.bound !== "true"){
        fileInput.dataset.bound = "true";
        fileInput.addEventListener("change", () => {
          const file = fileInput.files[0];
          const restoreBtn = document.getElementById("restoreBackupBtn");
          pendingRestoreData = null;
          restoreBtn.classList.add("u-hidden");
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try{
              pendingRestoreData = JSON.parse(reader.result);
              renderRestorePreview(pendingRestoreData);
              restoreBtn.classList.remove("u-hidden");
            }catch(err){
              window.YF.ui.toast({ type:"danger", title:"Invalid file", message:"That doesn't look like a valid backup JSON file." });
            }
          };
          reader.readAsText(file);
        });
      }
      const restoreBtn = document.getElementById("restoreBackupBtn");
      if (restoreBtn && restoreBtn.dataset.bound !== "true"){
        restoreBtn.dataset.bound = "true";
        restoreBtn.addEventListener("click", async () => {
          if (!pendingRestoreData) return;
          const totalRecords = Object.values(pendingRestoreData).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
          if (!confirm(`Merge ${totalRecords} record(s) from this backup into your live data? Existing documents with the same id will be updated, not replaced wholesale.`)) return;
          const fb = window.YF.firebase;
          restoreBtn.disabled = true; restoreBtn.textContent = "Restoring…";
          try{
            for (const [collectionName, rows] of Object.entries(pendingRestoreData)){
              if (!Array.isArray(rows) || !rows.length) continue;
              for (let i = 0; i < rows.length; i += 450){
                const batch = fb.writeBatch(fb.db);
                rows.slice(i, i + 450).forEach(row => {
                  const { id, ...fields } = row;
                  if (!id) return;
                  batch.set(fb.doc(fb.db, collectionName, id), fields, { merge: true });
                });
                await batch.commit();
              }
            }
            logActivity("backup_restore", `Restored/merged ${totalRecords} records from an uploaded backup file`);
            window.YF.ui.toast({ type:"success", title:"Restore complete", message:`${totalRecords} record(s) merged in.` });
            restoreBtn.classList.add("u-hidden");
            document.getElementById("restoreBackupFile").value = "";
            pendingRestoreData = null;
          }catch(err){
            window.YF.ui.toast({ type:"danger", title:"Restore failed", message: err.message || "Please try again." });
          }finally{
            restoreBtn.disabled = false; restoreBtn.textContent = "Import & Merge";
          }
        });
      }
    }

    /** Entry point wired from handleRouteClick for data-route="admin-backup". */
    function renderBackupPage(){
      if (!isAdmin()){
        window.YF.ui.navigateTo("home");
        return;
      }
      bindBackupPage();
    }

    function init(){
      // Nothing to eagerly bind at boot — the products listener starts
      // only once an admin actually opens Product Management, and page
      // controls are bound lazily the first time each admin page opens
      // (see renderProductsPage() / bindProductsPage()).
    }

    return {
      init, renderDashboard, renderProductsPage, renderCategoriesPage, renderPaymentsPage, renderPaymentMethodsPage,
      renderAdminLicensesPage,
      renderSocialSettingsPage,
      renderBrokersPage,
      renderSiteSettingsPage, renderCommunicationPage, renderLegalPage, isAdmin,
      renderUsersPage, ensureUsersLoaded, getUsersCache, openUserActivity,
      renderCouponsPage, renderAnnouncementsPage, renderNotificationTemplatesPage, renderActivityLogsPage,
      renderEarningsPage, renderWithdrawalsPage, renderAffiliatesPage, renderAnalyticsPage,
      renderAdminTicketsPage, renderAdminChatPage, renderAdminBlogPage, renderAdminContactMessagesPage,
      renderReportsPage, renderBackupPage,
      renderAdminBundlesPage, renderReviewsModPage
    };
  })();