import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken as getAppCheckToken } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, getDoc, onSnapshot, query, orderBy, where, getDocs, updateDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAYcuEqGtL18FwydvsCAd5xjk4GQme6N5c",
    authDomain: "silveri-118b5.firebaseapp.com",
    projectId: "silveri-118b5",
    storageBucket: "silveri-118b5.firebasestorage.app",
    messagingSenderId: "981654569884",
    appId: "1:981654569884:web:73413d6a1697878cb27e59",
    measurementId: "G-HKBQXSS3RY"
};

const app = initializeApp(firebaseConfig);


// App Check: підтверджує, що запити до Firestore/Storage йдуть саме з нашого
// сайту, а не зі скрипта/бота. reCAPTCHA v3 — невидима для відвідувача,
// нічого показувати чи клікати не треба.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
const appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6Lc7m7wtAAAAALbkOTY1oe28WmkfIgMxdZJ-yyqz'),
    isTokenAutoRefreshEnabled: true
});

// Токен App Check для наших Netlify Functions (cart.js шле його в заголовку
// X-Firebase-AppCheck при оформленні замовлення; create-order перевіряє його на сервері).
// Повертає null, якщо токен отримати не вдалося — функція тоді сама вирішує, що робити.
window.silveriGetAppCheckToken = async () => {
    try {
        const { token } = await getAppCheckToken(appCheck, /* forceRefresh */ false);
        return token || null;
    } catch (e) {
        console.warn('App Check: не вдалося отримати токен', e);
        return null;
    }
};

const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);


const CONTACT_INFO = {
    tgUsername: "solomia_ka",
    phoneNumber: "+380680243337"
};

// --- УТИЛІТИ ---
// Захист від XSS-атак при вставці даних у DOM
// Аналітика: виклик ізольований — помилка трекінгу не може зламати відмальовку сторінки.
// На сторінках без analytics.js (admin.html) window.SilveriAnalytics відсутній — нічого не відбувається.
const track = (fn) => {
    try {
        if (window.SilveriAnalytics) fn(window.SilveriAnalytics);
    } catch (e) {
        console.warn('Аналітика:', e);
    }
};

const escapeHTML = (str) => typeof str === 'string' 
    ? str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[tag]) 
    : str;

// --- 1. КЛІЄНТСЬКА ЧАСТИНА (ГОЛОВНА) ---
const PAGE_SIZE = 12; // товарів на сторінці каталогу
let allProducts = [];  // повний список товарів з бази (оновлюється в реальному часі)

// Один спільний "слухач" бази — і для каталогу, і для блоку "Популярні",
// щоб не робити два окремих читання Firestore на кожне завантаження сторінки
function fetchAndRenderProducts() {
    const grid = document.getElementById('product-grid');
    const popularGrid = document.getElementById('popular-grid');
    if (!grid && !popularGrid) return; // на цій сторінці немає жодного місця для показу товарів

    if (grid) grid.innerHTML = '<p class="loading-msg">Завантаження колекції...</p>';
    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));

    onSnapshot(q, (snapshot) => {
        allProducts = snapshot.docs.map(d => d.data());

        if (allProducts.length === 0) {
            if (grid) grid.innerHTML = '<p class="empty-msg">Товарів поки немає.</p>';
            const pagination = document.getElementById('pagination');
            if (pagination) pagination.innerHTML = '';
            renderFeatured();
            return;
        }

        renderCatalog();
        renderFeatured();
    });
}

function productUrl(product) {
    return `product.html?id=${encodeURIComponent(product.id)}`;
}

function buildProductCard(product) {
    const { id, title, description, price, image, category, inStock } = product;
    const safeTitle = escapeHTML(title);
    const safeDesc = escapeHTML(description);
    const safeId = escapeHTML(id);
    const safeImage = escapeHTML(image) || 'img/placeholder.jpg';
    const safeCategory = (category || "").toLowerCase();
    const url = productUrl(product);
    const outOfStock = inStock === false;

    const card = document.createElement('div');
    card.className = 'product-card' + (outOfStock ? ' out-of-stock' : '');
    card.dataset.category = safeCategory;

    card.innerHTML = `
        <a href="${url}" class="product-link" aria-label="Переглянути ${safeTitle}">
            <div class="product-id">Артикул: ${safeId || '---'}</div>
            <div class="product-img">
                ${outOfStock ? '<span class="stock-badge">Немає в наявності</span>' : ''}
                <img src="${safeImage}" alt="${safeTitle}" loading="lazy" decoding="async">
            </div>
            <h3>${safeTitle}</h3>
        </a>
        <p class="product-desc">${safeDesc}</p>
        <p class="price">${price} грн</p>
        <button class="cart-btn" data-id="${safeId}" data-title="${safeTitle}" data-price="${price}" data-image="${safeImage}" data-category="${safeCategory}" ${outOfStock ? 'disabled' : ''}>
            ${outOfStock ? 'Немає в наявності' : 'У кошик'}
        </button>
    `;
    return card;
}

// Фільтрує повний список за поточною категорією, сортує, ділить на сторінки й рендерить поточну
function renderCatalog() {
    const grid = document.getElementById('product-grid');
    if (!grid) return;

    let filtered = currentFilter === 'all'
        ? [...allProducts]
        : allProducts.filter(p => (p.category || "").toLowerCase() === currentFilter);

    const sortSelect = document.getElementById('sort-select');
    const sortValue = sortSelect ? sortSelect.value : 'newest';
    if (sortValue === 'price-asc') filtered.sort((a, b) => a.price - b.price);
    else if (sortValue === 'price-desc') filtered.sort((a, b) => b.price - a.price);
    // 'newest' — вже відсортовано запитом Firestore (orderBy createdAt desc)

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;

    if (filtered.length === 0) {
        grid.innerHTML = '<p class="empty-msg">У цій категорії поки немає товарів.</p>';
        renderPagination(0);
        return;
    }

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    const fragment = document.createDocumentFragment();
    pageItems.forEach(product => fragment.appendChild(buildProductCard(product)));

    grid.innerHTML = '';
    grid.appendChild(fragment);

    renderPagination(filtered.length);

    track(a => a.viewItemList('catalog', currentFilter === 'all' ? 'Каталог' : `Каталог: ${currentFilter}`, pageItems));
}

// Малює кнопки-номери сторінок під каталогом
function renderPagination(totalItems) {
    const pagination = document.getElementById('pagination');
    if (!pagination) return;

    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    pagination.innerHTML = '';

    if (totalPages <= 1) return; // немає сенсу показувати пагінацію на 1 сторінку

    for (let i = 1; i <= totalPages; i++) {
        const btn = document.createElement('button');
        btn.className = 'page-btn' + (i === currentPage ? ' active' : '');
        btn.textContent = i;
        btn.setAttribute('aria-label', `Сторінка ${i}`);
        if (i === currentPage) btn.setAttribute('aria-current', 'page');
        btn.addEventListener('click', () => goToPage(i));
        pagination.appendChild(btn);
    }
}

// Публічний блок відгуків (головна + сторінка товару) — тільки опубліковані, найновіші спершу
function renderPublicReviews() {
    const grid = document.getElementById('reviews-grid');
    if (!grid) return;

    const q = query(
        collection(db, "reviews"),
        where("published", "==", true),
        orderBy("sortOrder", "desc")
    );

    onSnapshot(q, (snapshot) => {
        if (snapshot.empty) {
            grid.innerHTML = '<p class="empty-msg">Відгуків поки немає.</p>';
            return;
        }

        const fragment = document.createDocumentFragment();
        snapshot.forEach((reviewDoc) => {
            const data = reviewDoc.data();
            const card = document.createElement('div');
            card.className = 'review-card';
            card.innerHTML = `
                ${data.image ? `<img src="${escapeHTML(data.image)}" alt="Відгук клієнта" class="review-photo" loading="lazy">` : ''}
                <div class="review-stars">${renderStars(data.rating)}</div>
                <p class="review-text">${escapeHTML(data.text)}</p>
                <p class="review-author">— ${escapeHTML(data.name)}</p>
            `;
            fragment.appendChild(card);
        });

        grid.innerHTML = '';
        grid.appendChild(fragment);
    });
}

function goToPage(pageNumber) {
    currentPage = pageNumber;
    renderCatalog();
    document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Блок "Популярні товари" — рендериться з уже завантажених даних (allProducts),
// без окремого запиту до Firestore
function renderFeatured() {
    const grid = document.getElementById('popular-grid');
    const section = document.getElementById('popular');
    if (!grid) return;

    const featured = allProducts.filter(p => p.featured).slice(0, 8); // 4×2 сітка

    if (featured.length === 0) {
        if (section) section.style.display = 'none'; // немає позначених товарів — ховаємо секцію
        return;
    }

    if (section) section.style.display = '';
    const fragment = document.createDocumentFragment();
    featured.forEach(product => fragment.appendChild(buildProductCard(product)));
    grid.innerHTML = '';
    grid.appendChild(fragment);

    track(a => a.viewItemList('popular', 'Популярні', featured));
}

// --- Сторінка окремого товару (product.html?id=АРТИКУЛ) ---
async function initProductPage() {
    const root = document.getElementById('product-page-root');
    if (!root) return; // не на сторінці товару — нічого робити

    const productId = new URLSearchParams(window.location.search).get('id');
    if (!productId) {
        renderProductNotFound(root);
        return;
    }

    try {
        const q = query(collection(db, "products"), where("id", "==", productId));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            renderProductNotFound(root);
            return;
        }

        const product = snapshot.docs[0].data();
        renderProductDetail(root, product);
        loadRelatedProducts(product);
        renderPublicReviews();
    } catch (e) {
        console.error("Помилка завантаження товару:", e);
        renderProductNotFound(root);
    }
}

function renderProductNotFound(root) {
    track(a => a.pageView({ title: 'Товар не знайдено | Silveri Jewelry' }));
    root.innerHTML = `
        <div class="product-not-found">
            <h1>Товар не знайдено</h1>
            <p>Можливо, посилання застаріле або товар більше не в каталозі.</p>
            <a href="catalog.html" class="btn-main">Повернутись у каталог</a>
        </div>
    `;
}

function renderProductDetail(root, product) {
    const { id, title, description, price, image, category, weight, size, purity, coating, inStock } = product;
    const safeTitle = escapeHTML(title);
    const safeDesc = escapeHTML(description);
    const safeId = escapeHTML(id);
    const safeImage = escapeHTML(image) || 'img/placeholder.jpg';
    const safeCategory = escapeHTML(category) || '';
    const safePurity = escapeHTML(purity) || '925';
    const outOfStock = inStock === false;

    // Оновлюємо title і meta-теги сторінки під конкретний товар (для вкладки браузера й базового SEO)
    document.title = `${title} — купити срібло ${safePurity} проби | Silveri Jewelry`;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', `${title} — ${description}. Ціна: ${price} грн. Срібло ${safePurity} проби.`);
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', `${title} | Silveri Jewelry`);
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute('content', `${description} Ціна: ${price} грн.`);
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) ogImage.setAttribute('content', image);

    // Breadcrumb: Головна → Каталог → [Категорія]
    const breadcrumbCurrent = document.getElementById('breadcrumb-current');
    if (breadcrumbCurrent && category) {
        breadcrumbCurrent.outerHTML = `<a href="catalog.html?category=${encodeURIComponent(category)}" class="current" id="breadcrumb-current">${safeCategory}</a>`;
    }

    // Рядок "Характеристики" будуємо тільки з полів, які адмін реально заповнив
    const specs = [
        weight ? ['Вага', escapeHTML(weight)] : null,
        size ? ['Розмір', escapeHTML(size)] : null,
        purity ? ['Проба', `${safePurity} (срібло)`] : null,
        coating ? ['Покриття', escapeHTML(coating)] : null,
    ].filter(Boolean);

    const specsHtml = specs.length
        ? specs.map(([label, value]) => `
            <div class="spec-row"><span class="spec-label">${label}</span><span class="spec-value">${value}</span></div>
        `).join('')
        : '<p class="empty-msg">Характеристики уточнюються.</p>';

    root.innerHTML = `
        <div class="product-page-grid">
            <div class="product-page-photo">
                ${outOfStock ? '<span class="stock-badge">Немає в наявності</span>' : ''}
                <img src="${safeImage}" alt="${safeTitle}" width="600" height="600">
            </div>
            <div class="product-page-info">
                <h1>${safeTitle}</h1>
                <div class="product-id">Артикул: ${safeId || '---'}</div>
                <p class="stock-status ${outOfStock ? 'out' : 'in'}">● ${outOfStock ? 'Немає в наявності' : 'В наявності'}</p>
                <p class="product-page-price">${price} грн</p>
                <p class="product-page-material">Срібло ${safePurity} проби${size ? ` · Розмір ${escapeHTML(size)}` : ''}</p>
                <p class="product-page-desc">${safeDesc || 'Опис уточнюється.'}</p>

                <div class="product-page-actions">
                    <button class="cart-btn" data-id="${safeId}" data-title="${safeTitle}" data-price="${price}" data-image="${safeImage}" data-category="${safeCategory}" ${outOfStock ? 'disabled' : ''}>
                        ${outOfStock ? 'Немає в наявності' : 'У кошик'}
                    </button>
                </div>

                <div class="product-page-info-blocks">
                    <p>🚚 <strong>Доставка</strong> — Новою поштою або Укрпоштою по всій Україні.</p>
                    <p>↩ <strong>Повернення</strong> — Ваша покупка захищена. Ми підтримуємо 14-денний термін повернення кожного товару. Якщо ви не повністю задоволені своєю покупкою, ми повністю повернемо вам кошти.</p>
                </div>
            </div>
        </div>

        <div class="product-page-section-block">
            <h2 class="section-title">Характеристики</h2>
            <div class="specs-list">${specsHtml}</div>
        </div>

        <div class="product-page-section-block">
            <h2 class="section-title">Відгуки</h2>
            <div class="reviews-grid" id="reviews-grid" aria-live="polite"></div>
        </div>

        <div class="product-page-section-block" id="related-products-block" hidden>
            <h2 class="section-title">Схожі товари</h2>
            <div class="product-grid" id="related-grid"></div>
        </div>

        <div class="not-found-section">
            <h3>Не знайшли потрібну прикрасу?</h3>
            <p>Напишіть нам — підберемо прикрасу під ваш запит особисто.</p>
            <div class="not-found-buttons">
                <a href="https://t.me/solomia_ka" target="_blank" rel="noopener noreferrer" class="modal-btn btn-tg">Telegram</a>
                <a href="viber://chat?number=%2B380680243337" target="_blank" rel="noopener noreferrer" class="modal-btn btn-vb">Viber</a>
            </div>
        </div>
    `;

    // Canonical: одна адреса на товар (сайт віддає його і як product.html?id=X, і як /product/X)
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
    }
    canonical.href = `https://silveri.com.ua/product.html?id=${encodeURIComponent(id)}`;

    // Аналітика: page_view з правильним заголовком (він щойно виставлений вище) + view_item
    track(a => {
        a.pageView({ title: document.title });
        a.viewItem({ id, title, price, category });
    });
}

// "Схожі товари" — до 4 товарів з тієї ж категорії, окрім поточного
async function loadRelatedProducts(product) {
    const block = document.getElementById('related-products-block');
    const grid = document.getElementById('related-grid');
    if (!block || !grid || !product.category) return;

    try {
        const q = query(collection(db, "products"), where("category", "==", product.category));
        const snapshot = await getDocs(q);

        const related = snapshot.docs
            .map(d => d.data())
            .filter(p => p.id !== product.id)
            .slice(0, 4);

        if (related.length === 0) return; // блок лишається прихованим

        const fragment = document.createDocumentFragment();
        related.forEach(p => fragment.appendChild(buildProductCard(p)));
        grid.appendChild(fragment);
        block.hidden = false;
        track(a => a.viewItemList('related', 'Схожі товари', related));
    } catch (e) {
        console.error("Помилка завантаження схожих товарів:", e);
    }
}




window.login = async () => {
    const email = document.getElementById('adminEmail').value.trim();
    const pass = document.getElementById('adminPass').value;
    const errorP = document.getElementById('login-error');

    if (!email || !pass) {
        errorP.textContent = "Заповніть всі поля!";
        return;
    }

    try {
        await signInWithEmailAndPassword(auth, email, pass);
        errorP.textContent = "";
    } catch (error) {
        console.error("Помилка авторизації:", error.code);
        errorP.textContent = "Помилка: невірний логін або пароль.";
    }
};

window.logout = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
    const loginScreen = document.getElementById('login-screen');
    const adminPanel = document.getElementById('admin-panel');

    if (adminPanel && loginScreen) {
        const isLoggedIn = !!user;
        loginScreen.style.display = isLoggedIn ? 'none' : 'flex';
        adminPanel.style.display = isLoggedIn ? 'block' : 'none';
        if (isLoggedIn) {
            renderAdminList();
            renderPackagingAdminList();
            renderOrdersList();
            renderReviewsList();
        }
    }
});

// Стискає фото товару в браузері перед завантаженням у Storage:
// зменшує до розумного максимального розміру і перекодовує в JPEG.
// Це найбільше впливає на швидкість каталогу — фото з телефону (кілька МБ)
// стають ~100-300 КБ, без втрати якості, помітної на сайті.
function compressImage(file, maxDimension = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
            let { width, height } = img;
            if (width > maxDimension || height > maxDimension) {
                const scale = maxDimension / Math.max(width, height);
                width = Math.round(width * scale);
                height = Math.round(height * scale);
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);

            canvas.toBlob(
                (blob) => {
                    URL.revokeObjectURL(objectUrl);
                    blob ? resolve(blob) : reject(new Error('Не вдалося стиснути зображення'));
                },
                'image/jpeg',
                quality
            );
        };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Не вдалося завантажити зображення')); };
        img.src = objectUrl;
    });
}

window.uploadProduct = async () => {
    const status = document.getElementById('status');
    const fileInput = document.getElementById('prodImg');
    const form = document.querySelector('.admin-form');
    const submitBtn = form.querySelector('button.order-btn');
    const file = fileInput.files[0];

    const id = document.getElementById('prodId').value.trim();
    const title = document.getElementById('prodTitle').value.trim();
    const priceRaw = document.getElementById('prodPrice').value;
    const price = Number(priceRaw);
    const category = document.getElementById('prodCategory').value;
    const description = document.getElementById('prodDesc').value.trim();

    // Валідація обов'язкових полів перед завантаженням
    if (!id) return alert("Вкажіть артикул!");
    if (!title) return alert("Вкажіть назву товару!");
    if (!priceRaw || isNaN(price) || price <= 0) return alert("Вкажіть коректну ціну!");
    if (!category) return alert("Оберіть категорію!");
    if (!file) return alert("Оберіть фото!");

    submitBtn.disabled = true; // захист від подвійного кліку під час завантаження

    try {
        // Перевірка на дублікат артикулу — на нього посилається URL сторінки товару,
        // тож два товари з однаковим артикулом конфліктуватимуть
        status.textContent = "Перевірка артикулу...";
        const dupCheck = await getDocs(query(collection(db, "products"), where("id", "==", id)));
        if (!dupCheck.empty) {
            alert(`Товар з артикулом "${id}" вже існує. Оберіть інший артикул.`);
            status.textContent = "";
            submitBtn.disabled = false;
            return;
        }

        status.textContent = "Стиснення фото...";
        const compressedBlob = await compressImage(file);
        const fileName = `${Date.now()}_${file.name.replace(/\.[^/.]+$/, '')}.jpg`;
        const storageRef = ref(storage, `products/${fileName}`);
        status.textContent = "Завантаження...";
        const snapshot = await uploadBytes(storageRef, compressedBlob);
        const downloadURL = await getDownloadURL(snapshot.ref);

        await addDoc(collection(db, "products"), {
            id,
            title,
            price,
            category,
            description,
            weight: document.getElementById('prodWeight').value.trim(),
            size: document.getElementById('prodSize').value.trim(),
            purity: document.getElementById('prodPurity').value.trim() || '925',
            coating: document.getElementById('prodCoating').value.trim(),
            inStock: document.getElementById('prodInStock').checked,
            image: downloadURL,
            featured: document.getElementById('prodFeatured').checked,
            createdAt: new Date()
        });
        
        status.textContent = "Товар успішно додано!";
        form.reset();
        setTimeout(() => status.textContent = "", 3000); // Очищення статусу
    } catch (e) {
        status.textContent = "Помилка завантаження!";
        console.error(e);
    } finally {
        submitBtn.disabled = false;
    }
};

window.deleteProduct = async (docId, imageUrl) => {
    if (!confirm("Видалити товар?")) return;
    try {
        if (imageUrl?.includes("firebasestorage")) {
            await deleteObject(ref(storage, imageUrl));
        }
        await deleteDoc(doc(db, "products", docId));
    } catch (error) { 
        console.error("Помилка видалення:", error); 
        alert("Не вдалося видалити товар.");
    }
};

window.openEditModal = async (docId) => {
    const status = document.getElementById('editStatus');
    status.textContent = '';
    try {
        const snap = await getDoc(doc(db, "products", docId));
        if (!snap.exists()) return alert("Товар не знайдено (можливо, вже видалений).");

        const data = snap.data();
        document.getElementById('editDocId').value = docId;
        document.getElementById('editOriginalId').value = data.id || '';
        document.getElementById('editId').value = data.id || '';
        document.getElementById('editTitle').value = data.title || '';
        document.getElementById('editPrice').value = data.price ?? '';
        document.getElementById('editCategory').value = data.category || '';
        document.getElementById('editDesc').value = data.description || '';
        document.getElementById('editWeight').value = data.weight || '';
        document.getElementById('editSize').value = data.size || '';
        document.getElementById('editPurity').value = data.purity || '925';
        document.getElementById('editCoating').value = data.coating || '';
        document.getElementById('editFeatured').checked = !!data.featured;
        document.getElementById('editInStock').checked = data.inStock !== false;
        document.getElementById('editCurrentImg').src = data.image || '';
        document.getElementById('editImg').value = '';

        document.getElementById('edit-modal').style.display = 'flex';
    } catch (e) {
        console.error("Помилка завантаження товару для редагування:", e);
        alert("Не вдалося завантажити дані товару.");
    }
};

window.closeEditModal = () => {
    document.getElementById('edit-modal').style.display = 'none';
};

window.saveProductEdit = async () => {
    const status = document.getElementById('editStatus');
    const docId = document.getElementById('editDocId').value;
    const saveBtn = document.querySelector('#edit-modal .order-btn');

    const id = document.getElementById('editId').value.trim();
    const title = document.getElementById('editTitle').value.trim();
    const price = Number(document.getElementById('editPrice').value);
    const category = document.getElementById('editCategory').value;
    const description = document.getElementById('editDesc').value.trim();
    const newFile = document.getElementById('editImg').files[0];

    if (!id) return alert("Вкажіть артикул!");
    if (!title) return alert("Вкажіть назву товару!");
    if (!price || price <= 0) return alert("Вкажіть коректну ціну!");
    if (!category) return alert("Оберіть категорію!");

    saveBtn.disabled = true;

    try {
        // Якщо артикул змінили — перевіряємо, що новий не конфліктує з іншим товаром
        const originalId = document.getElementById('editOriginalId').value;
        if (id !== originalId) {
            status.textContent = "Перевірка артикулу...";
            const dupCheck = await getDocs(query(collection(db, "products"), where("id", "==", id)));
            const conflict = dupCheck.docs.find(d => d.id !== docId);
            if (conflict) {
                alert(`Товар з артикулом "${id}" вже існує. Оберіть інший артикул.`);
                status.textContent = "";
                saveBtn.disabled = false;
                return;
            }
        }

        const updateData = {
            id, title, price, category, description,
            weight: document.getElementById('editWeight').value.trim(),
            size: document.getElementById('editSize').value.trim(),
            purity: document.getElementById('editPurity').value.trim() || '925',
            coating: document.getElementById('editCoating').value.trim(),
            featured: document.getElementById('editFeatured').checked,
            inStock: document.getElementById('editInStock').checked,
        };

        if (newFile) {
            status.textContent = "Стиснення нового фото...";
            const compressedBlob = await compressImage(newFile);
            const fileName = `${Date.now()}_${newFile.name.replace(/\.[^/.]+$/, '')}.jpg`;
            const storageRef = ref(storage, `products/${fileName}`);
            status.textContent = "Завантаження нового фото...";
            const snapshot = await uploadBytes(storageRef, compressedBlob);
            updateData.image = await getDownloadURL(snapshot.ref);

            // Видаляємо старе фото зі Storage, щоб не накопичувалось сміття
            const oldImage = document.getElementById('editCurrentImg').src;
            if (oldImage?.includes("firebasestorage")) {
                deleteObject(ref(storage, oldImage)).catch(() => {}); // не критично, якщо не вийде
            }
        }

        status.textContent = "Збереження...";
        await updateDoc(doc(db, "products", docId), updateData);

        status.textContent = "Збережено!";
        setTimeout(() => { closeEditModal(); status.textContent = ''; }, 800);
    } catch (e) {
        console.error("Помилка збереження змін товару:", e);
        status.textContent = "Помилка збереження!";
    } finally {
        saveBtn.disabled = false;
    }
};

window.toggleFeatured = async (docId, currentState) => {
    try {
        await updateDoc(doc(db, "products", docId), { featured: !currentState });
    } catch (e) {
        console.error("Помилка оновлення статусу 'Популярне':", e);
        alert("Не вдалося оновити статус.");
    }
};

window.toggleInStock = async (docId, currentState) => {
    try {
        await updateDoc(doc(db, "products", docId), { inStock: !currentState });
    } catch (e) {
        console.error("Помилка оновлення наявності:", e);
        alert("Не вдалося оновити наявність.");
    }
};

// --- Пакування (адмінка: розділ 5 ТЗ) ---
// Той самий перевірений патерн, що й для товарів: унікальний технічний id,
// стиснення фото перед завантаженням у Storage, onSnapshot-список у реальному часі.
// Особливості, яких немає в товарах: isDefault (лише один варіант може бути дефолтним
// одночасно — знімаємо прапорець з інших через writeBatch) і заборона видалення
// варіанта, який уже використовувався хоча б в одному замовленні (лише деактивація).

// Знімає isDefault з усіх варіантів пакування, крім вказаного docId (або з усіх, якщо null).
// Викликається після встановлення isDefault:true нового/відредагованого варіанта.
async function clearOtherDefaultPackaging(exceptDocId) {
    const snap = await getDocs(query(collection(db, "packaging"), where("isDefault", "==", true)));
    const batch = writeBatch(db);
    let hasChanges = false;
    snap.forEach((d) => {
        if (d.id !== exceptDocId) {
            batch.update(d.ref, { isDefault: false });
            hasChanges = true;
        }
    });
    if (hasChanges) await batch.commit();
}

window.uploadPackaging = async () => {
    const status = document.getElementById('packStatus');
    const fileInput = document.getElementById('packImg');
    const submitBtn = document.querySelector('#tab-packaging .admin-form .order-btn');
    const file = fileInput.files[0];

    const id = document.getElementById('packId').value.trim();
    const title = document.getElementById('packTitle').value.trim();
    const priceRaw = document.getElementById('packPrice').value;
    const price = Number(priceRaw);
    const description = document.getElementById('packDesc').value.trim();
    const sortOrder = Number(document.getElementById('packSortOrder').value) || 0;
    const isDefault = document.getElementById('packIsDefault').checked;
    const active = document.getElementById('packActive').checked;

    if (!id) return alert("Вкажіть технічний ID!");
    if (!title) return alert("Вкажіть назву!");
    if (priceRaw === '' || isNaN(price) || price < 0) return alert("Вкажіть коректну ціну (0 або більше)!");
    if (!file) return alert("Оберіть фото!");

    submitBtn.disabled = true;

    try {
        status.textContent = "Перевірка ID...";
        const dupCheck = await getDocs(query(collection(db, "packaging"), where("id", "==", id)));
        if (!dupCheck.empty) {
            alert(`Варіант пакування з ID "${id}" вже існує. Оберіть інший ID.`);
            status.textContent = "";
            submitBtn.disabled = false;
            return;
        }

        status.textContent = "Стиснення фото...";
        const compressedBlob = await compressImage(file);
        const fileName = `${Date.now()}_${file.name.replace(/\.[^/.]+$/, '')}.jpg`;
        const storageRef = ref(storage, `packaging/${fileName}`);
        status.textContent = "Завантаження...";
        const snapshot = await uploadBytes(storageRef, compressedBlob);
        const downloadURL = await getDownloadURL(snapshot.ref);

        const newDoc = await addDoc(collection(db, "packaging"), {
            id, title, price, description, sortOrder,
            image: downloadURL,
            isDefault,
            active,
            createdAt: new Date()
        });

        if (isDefault) await clearOtherDefaultPackaging(newDoc.id);

        status.textContent = "Варіант пакування додано!";
        document.querySelector('#tab-packaging .admin-form').reset();
        document.getElementById('packActive').checked = true;
        document.getElementById('packPrice').value = 0;
        document.getElementById('packSortOrder').value = 1;
        setTimeout(() => status.textContent = "", 3000);
    } catch (e) {
        status.textContent = "Помилка завантаження!";
        console.error(e);
    } finally {
        submitBtn.disabled = false;
    }
};

window.deletePackaging = async (docId, id, imageUrl) => {
    try {
        const usedCheck = await getDocs(query(collection(db, "orders"), where("packaging.id", "==", id)));
        if (!usedCheck.empty) {
            alert("Це упакування вже використовувалось у замовленнях і не може бути видалене. Натомість деактивуйте його (кнопка 📦).");
            return;
        }
    } catch (e) {
        console.error("Не вдалося перевірити використання в замовленнях:", e);
        alert("Не вдалося перевірити, чи використовувалось це пакування в замовленнях. Спробуйте ще раз.");
        return;
    }

    if (!confirm("Видалити варіант пакування?")) return;
    try {
        if (imageUrl?.includes("firebasestorage")) {
            await deleteObject(ref(storage, imageUrl));
        }
        await deleteDoc(doc(db, "packaging", docId));
    } catch (error) {
        console.error("Помилка видалення пакування:", error);
        alert("Не вдалося видалити варіант пакування.");
    }
};

window.togglePackagingActive = async (docId, currentState) => {
    try {
        await updateDoc(doc(db, "packaging", docId), { active: !currentState });
    } catch (e) {
        console.error("Помилка оновлення активності пакування:", e);
        alert("Не вдалося оновити активність.");
    }
};

window.setPackagingDefault = async (docId, currentState) => {
    try {
        if (currentState) {
            // Дефолтний варіант має бути завжди рівно один — просто зняти прапорець без заміни не можна
            alert("Оберіть інший варіант дефолтним — цей автоматично перестане бути дефолтним.");
            return;
        }
        await updateDoc(doc(db, "packaging", docId), { isDefault: true });
        await clearOtherDefaultPackaging(docId);
    } catch (e) {
        console.error("Помилка оновлення дефолтного пакування:", e);
        alert("Не вдалося оновити дефолтний варіант.");
    }
};

window.openEditPackagingModal = async (docId) => {
    const status = document.getElementById('editPackStatus');
    status.textContent = '';
    try {
        const snap = await getDoc(doc(db, "packaging", docId));
        if (!snap.exists()) return alert("Варіант пакування не знайдено (можливо, вже видалений).");

        const data = snap.data();
        document.getElementById('editPackDocId').value = docId;
        document.getElementById('editPackOriginalId').value = data.id || '';
        document.getElementById('editPackId').value = data.id || '';
        document.getElementById('editPackTitle').value = data.title || '';
        document.getElementById('editPackPrice').value = data.price ?? 0;
        document.getElementById('editPackDesc').value = data.description || '';
        document.getElementById('editPackSortOrder').value = data.sortOrder ?? 0;
        document.getElementById('editPackIsDefault').checked = !!data.isDefault;
        document.getElementById('editPackActive').checked = data.active !== false;
        document.getElementById('editPackCurrentImg').src = data.image || '';
        document.getElementById('editPackImg').value = '';

        document.getElementById('edit-packaging-modal').style.display = 'flex';
    } catch (e) {
        console.error("Помилка завантаження пакування для редагування:", e);
        alert("Не вдалося завантажити дані варіанта пакування.");
    }
};

window.closeEditPackagingModal = () => {
    document.getElementById('edit-packaging-modal').style.display = 'none';
};

window.savePackagingEdit = async () => {
    const status = document.getElementById('editPackStatus');
    const docId = document.getElementById('editPackDocId').value;
    const saveBtn = document.querySelector('#edit-packaging-modal .order-btn');

    const id = document.getElementById('editPackId').value.trim();
    const title = document.getElementById('editPackTitle').value.trim();
    const priceRaw = document.getElementById('editPackPrice').value;
    const price = Number(priceRaw);
    const description = document.getElementById('editPackDesc').value.trim();
    const sortOrder = Number(document.getElementById('editPackSortOrder').value) || 0;
    const isDefault = document.getElementById('editPackIsDefault').checked;
    const active = document.getElementById('editPackActive').checked;
    const newFile = document.getElementById('editPackImg').files[0];

    if (!id) return alert("Вкажіть технічний ID!");
    if (!title) return alert("Вкажіть назву!");
    if (priceRaw === '' || isNaN(price) || price < 0) return alert("Вкажіть коректну ціну (0 або більше)!");

    saveBtn.disabled = true;

    try {
        const originalId = document.getElementById('editPackOriginalId').value;
        if (id !== originalId) {
            status.textContent = "Перевірка ID...";
            const dupCheck = await getDocs(query(collection(db, "packaging"), where("id", "==", id)));
            const conflict = dupCheck.docs.find(d => d.id !== docId);
            if (conflict) {
                alert(`Варіант пакування з ID "${id}" вже існує. Оберіть інший ID.`);
                status.textContent = "";
                saveBtn.disabled = false;
                return;
            }
        }

        const updateData = { id, title, price, description, sortOrder, isDefault, active };

        if (newFile) {
            status.textContent = "Стиснення нового фото...";
            const compressedBlob = await compressImage(newFile);
            const fileName = `${Date.now()}_${newFile.name.replace(/\.[^/.]+$/, '')}.jpg`;
            const storageRef = ref(storage, `packaging/${fileName}`);
            status.textContent = "Завантаження нового фото...";
            const snapshot = await uploadBytes(storageRef, compressedBlob);
            updateData.image = await getDownloadURL(snapshot.ref);

            const oldImage = document.getElementById('editPackCurrentImg').src;
            if (oldImage?.includes("firebasestorage")) {
                deleteObject(ref(storage, oldImage)).catch(() => {});
            }
        }

        status.textContent = "Збереження...";
        await updateDoc(doc(db, "packaging", docId), updateData);
        if (isDefault) await clearOtherDefaultPackaging(docId);

        status.textContent = "Збережено!";
        setTimeout(() => { closeEditPackagingModal(); status.textContent = ''; }, 800);
    } catch (e) {
        console.error("Помилка збереження пакування:", e);
        status.textContent = "Помилка збереження!";
    } finally {
        saveBtn.disabled = false;
    }
};

function renderPackagingAdminList() {
    const listContainer = document.getElementById('admin-packaging-list');
    if (!listContainer) return;

    const q = query(collection(db, "packaging"), orderBy("sortOrder", "asc"));

    onSnapshot(q, (snapshot) => {
        const fragment = document.createDocumentFragment();

        if (snapshot.empty) {
            listContainer.innerHTML = '<p class="empty-msg">Варіантів пакування поки немає.</p>';
            return;
        }

        snapshot.forEach((packDoc) => {
            const data = packDoc.data();
            const safeTitle = escapeHTML(data.title);
            const safeId = escapeHTML(data.id) || '—';
            const priceLabel = Number(data.price) > 0 ? `${data.price} грн` : 'Безкоштовно';

            const item = document.createElement('div');
            item.className = 'admin-product-item';
            item.innerHTML = `
                <div class="admin-item-info">
                    <img src="${escapeHTML(data.image)}" class="admin-item-thumb" loading="lazy">
                    <div class="admin-item-text">
                        <span class="admin-item-title">${safeTitle}</span>
                        <span class="admin-item-sku">ID: ${safeId} · порядок: ${data.sortOrder ?? 0}</span>
                    </div>
                </div>
                <div class="admin-item-actions">
                    <span class="admin-item-price">${priceLabel}</span>
                    <button class="stock-btn packaging-active-btn ${data.active === false ? '' : 'active'}" data-id="${packDoc.id}" data-active="${data.active !== false}" title="Активний (доступний на чекауті)">📦</button>
                    <button class="star-btn packaging-default-btn ${data.isDefault ? 'active' : ''}" data-id="${packDoc.id}" data-isdefault="${!!data.isDefault}" title="Дефолтний варіант">★</button>
                    <button class="edit-btn packaging-edit-btn" data-id="${packDoc.id}" title="Редагувати">✏️</button>
                    <button class="delete-btn packaging-delete-btn" data-id="${packDoc.id}" data-packid="${safeId}" data-img="${data.image}" title="Видалити">🗑</button>
                </div>
            `;
            fragment.appendChild(item);
        });

        listContainer.innerHTML = '';
        listContainer.appendChild(fragment);
    });
}

// --- Пакування (клієнт: крок "Упакування" на чекауті) ---
// Firestore-доступ живе тут (тут ініціалізовано db), а рендер карток вибору й
// перерахунок підсумку — у cart.js (там же решта акордеону чекауту). Один
// одноразовий getDocs — асортимент пакувань не змінюється щосекунди (п. 5.8 ТЗ).
async function initCheckoutPackaging() {
    if (!document.getElementById('checkout-accordion')) return; // не сторінка чекауту

    try {
        const q = query(collection(db, "packaging"), where("active", "==", true), orderBy("sortOrder", "asc"));
        const snap = await getDocs(q);
        const options = snap.docs.map(d => {
            const data = d.data();
            return {
                id: data.id,
                title: data.title || '',
                description: data.description || '',
                price: Number(data.price) || 0,
                image: data.image || '',
                isDefault: !!data.isDefault,
            };
        });
        window.renderPackagingOptions?.(options);
    } catch (e) {
        console.error("Помилка завантаження варіантів пакування:", e);
        window.renderPackagingOptions?.([]);
    }
}

const ORDER_STATUS_LABELS = {
    awaiting_payment: 'Очікує оплату',
    new: 'Нове',
    processing: 'В обробці',
    shipped: 'Відправлено',
    done: 'Виконано',
    cancelled: 'Скасовано'
};

const DELIVERY_TYPE_LABELS = { nova_poshta: 'Нова Пошта' };
const DELIVERY_FORMAT_LABELS = { branch: 'Відділення', postomat: 'Поштомат' };
const PAYMENT_METHOD_LABELS = { online: 'Оплата карткою (monobank)', cod: 'Накладений платіж', fop: 'Оплата на рахунок ФОП' };

// Статуси оплати для online/cod (архітектурний опис, розділ 5.1). Замовлення fop
// сюди не потрапляють — для них paymentStatus лишається pending/paid без monobank.
const PAYMENT_STATUS_BADGES = {
    pending: { label: '⏳ Ще не оплачено', cls: 'pending' },
    processing: { label: '⏳ Очікує підтвердження', cls: 'pending' },
    paid: { label: '🟢 Оплачено', cls: 'paid' },
    prepaid: { label: '🟡 Передплата отримана', cls: 'pending' },
    failed: { label: '🔴 Оплата не пройшла', cls: 'failed' },
    expired: { label: '⚪ Термін оплати минув', cls: 'failed' },
    payment_error: { label: '🔴 Помилка створення оплати', cls: 'failed' },
    refunding: { label: '↩️ Повернення в обробці', cls: 'pending' },
    partially_refunded: { label: '↩️ Частково повернено', cls: 'pending' },
    refunded: { label: '↩️ Повернено', cls: 'failed' },
};
const NEEDS_ATTENTION_LABELS = {
    duplicate_payment: 'Виявлено подвійну оплату — потрібне ручне повернення',
    paid_after_cancel: 'Оплата надійшла вже після скасування замовлення',
    amount_mismatch: 'Сума від monobank не збігається з замовленням',
    unknown_invoice: 'Невідомий інвойс monobank для цього замовлення',
    refund_unknown: 'Результат повернення коштів не підтверджено',
    method_mismatch: 'Спосіб оплати не збігається з типом платежу',
    unexpected_status: 'Неочікуваний статус від monobank',
};

// Виклик адмінських платіжних функцій (mark-paid / create-admin-payment-link / cancel-payment)
// з ID-токеном поточного адміна. Для create-admin-payment-link і cancel-payment сервер додатково
// вимагає "свіжий" вхід (не старіший за ~5 хв) — якщо адмін увійшов давно, повертається 401
// і UI прямо просить вийти й увійти знову (архітектурний опис, 8.1).
async function callPaymentAdminFn(path, body) {
    if (!auth.currentUser) return { ok: false, error: 'Ви не увійшли в адмінку.' };
    const token = await auth.currentUser.getIdToken();
    let response;
    try {
        response = await fetch(`/.netlify/functions/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(body),
        });
    } catch (e) {
        return { ok: false, error: 'Немає з’єднання з сервером.' };
    }
    let data = null;
    try { data = await response.json(); } catch { /* ignore */ }
    if (response.status === 401) {
        return { ok: false, error: 'Сесія входу застаріла для цієї дії. Вийдіть і увійдіть в адмінку ще раз, потім спробуйте знову.' };
    }
    return { ok: response.ok, ...data };
}

function renderOrdersList() {
    const listContainer = document.getElementById('admin-orders-list');
    if (!listContainer) return;

    const statusFilter = document.getElementById('orderStatusFilter')?.value || 'all';
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));

    onSnapshot(q, (snapshot) => {
        const fragment = document.createDocumentFragment();
        let newCount = 0;

        snapshot.forEach((orderDoc) => {
            const data = orderDoc.data();
            // Підтримка як нової схеми (orderStatus/orderID), так і старих тестових замовлень (status)
            const status = data.orderStatus || data.status || 'new';
            const orderID = data.orderID || `#${orderDoc.id.slice(-6).toUpperCase()}`;
            const paymentStatus = data.paymentStatus || 'pending';
            if (status === 'new') newCount++;

            if (statusFilter !== 'all' && status !== statusFilter) return;

            const dateStr = data.createdAt?.toDate
                ? data.createdAt.toDate().toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '—';

            const itemsHtml = (data.items || []).map(item => `
                <div class="admin-order-line">
                    <img src="${escapeHTML(item.image) || 'img/placeholder.jpg'}" alt="${escapeHTML(item.title)}" class="admin-order-line-img" loading="lazy">
                    <div class="admin-order-line-info">
                        <span>${escapeHTML(item.title)} × ${item.qty}</span>
                        <span class="admin-order-line-articul">Артикул: ${escapeHTML(item.id)}</span>
                    </div>
                    <span class="admin-order-line-price">${item.price * item.qty} грн</span>
                </div>
            `).join('');

            const statusOptions = Object.entries(ORDER_STATUS_LABELS)
                .map(([value, label]) => `<option value="${value}" ${status === value ? 'selected' : ''}>${label}</option>`)
                .join('');

            const deliveryLabel = data.deliveryType
                ? `${DELIVERY_TYPE_LABELS[data.deliveryType] || data.deliveryType} → ${DELIVERY_FORMAT_LABELS[data.deliveryFormat] || ''} №${escapeHTML(data.warehouse)}, ${escapeHTML(data.city)}`
                : `${escapeHTML(data.deliveryMethod || '—')}, ${escapeHTML(data.city || '')}, ${escapeHTML(data.branch || '')}`; // фолбек для старих тестових замовлень

            const paymentLabel = PAYMENT_METHOD_LABELS[data.paymentMethod] || escapeHTML(data.paymentMethod) || '—';
            const isOnlineMethod = data.paymentMethod === 'online' || data.paymentMethod === 'cod';
            const badgeInfo = PAYMENT_STATUS_BADGES[paymentStatus] || (paymentStatus === 'paid' ? PAYMENT_STATUS_BADGES.paid : PAYMENT_STATUS_BADGES.pending);
            const paymentBadge = `<span class="payment-badge ${badgeInfo.cls}">${badgeInfo.label}</span>`;

            // "Позначити оплаченим" — лише для ручних переходів, які дозволяє mark-paid.mjs:
            // fop (pending -> paid) і фінальна оплата cod (prepaid -> paid, залишок при отриманні).
            // Для online оплату підтверджує лише monobank (вебхук/звірка).
            let markPaidBtn = '';
            if (data.paymentMethod === 'fop' && paymentStatus === 'pending') {
                markPaidBtn = `<button class="mark-paid-btn" data-id="${orderDoc.id}">Позначити оплаченим</button>`;
            } else if (data.paymentMethod === 'cod' && paymentStatus === 'prepaid') {
                const dueUah = data.dueOnDeliveryKop != null ? Math.round(data.dueOnDeliveryKop / 100) : null;
                markPaidBtn = `<button class="mark-paid-btn" data-id="${orderDoc.id}">Позначити отримання оплаченим${dueUah ? ` (${dueUah} грн)` : ''}</button>`;
            }

            // Посилання на оплату — коли інвойс ще не оплачений або застряг (pending/failed/expired/payment_error).
            let paymentLinkBtn = '';
            if (isOnlineMethod && ['pending', 'failed', 'expired', 'payment_error'].includes(paymentStatus)) {
                paymentLinkBtn = `<button class="payment-link-btn" data-id="${orderDoc.id}">Створити посилання на оплату</button>`;
            }

            // Повернення коштів — лише для успішно оплаченого online/cod платежу.
            let refundBtn = '';
            if (isOnlineMethod && ['paid', 'prepaid'].includes(paymentStatus) && data.invoiceId) {
                refundBtn = `<button class="refund-payment-btn" data-id="${orderDoc.id}" data-invoice="${escapeHTML(data.invoiceId)}" data-order-num="${escapeHTML(orderID)}">Повернути кошти</button>`;
            }

            const attentionInfo = data.needsAttention ? `
                <div class="admin-order-attention">
                    ⚠️ ${escapeHTML(NEEDS_ATTENTION_LABELS[data.needsAttention.reason] || data.needsAttention.reason || 'Потребує уваги')}
                </div>
            ` : '';

            const card = document.createElement('div');
            card.className = `admin-order-card status-${status}`;
            card.innerHTML = `
                <div class="admin-order-header">
                    <span class="admin-order-id">${escapeHTML(orderID)}</span>
                    <span class="admin-order-date">${dateStr}</span>
                    <select class="order-status-select admin-select" data-id="${orderDoc.id}">
                        ${statusOptions}
                    </select>
                </div>
                ${attentionInfo}
                <div class="admin-order-customer">
                    <strong>${escapeHTML(data.customerName)}</strong> · <a href="tel:${escapeHTML(data.customerPhone)}">${escapeHTML(data.customerPhone)}</a>
                    ${data.customerEmail ? ` · <a href="mailto:${escapeHTML(data.customerEmail)}">${escapeHTML(data.customerEmail)}</a>` : ''}
                </div>
                <div class="admin-order-delivery">🚚 ${deliveryLabel}</div>
                ${data.packaging ? `<div class="admin-order-delivery">🎁 ${escapeHTML(data.packaging.title)}${data.packaging.price > 0 ? ` (+${data.packaging.price} грн)` : ' (безкоштовно)'}</div>` : ''}
                <div class="admin-order-payment">
                    💳 ${paymentLabel} ${paymentBadge}
                    ${markPaidBtn}${paymentLinkBtn}${refundBtn}
                </div>
                ${data.comment ? `<div class="admin-order-comment">Коментар: ${escapeHTML(data.comment)}</div>` : ''}
                <div class="admin-order-items">${itemsHtml}</div>
                <div class="admin-order-total">Разом: ${data.total} грн</div>
            `;
            fragment.appendChild(card);
        });

        listContainer.innerHTML = '';
        if (!fragment.childNodes.length) {
            listContainer.innerHTML = '<p class="empty-msg">Замовлень поки немає.</p>';
        } else {
            listContainer.appendChild(fragment);
        }

        const badge = document.getElementById('new-orders-badge');
        if (badge) {
            badge.textContent = newCount;
            badge.hidden = newCount === 0;
        }
    });
}

window.updateOrderStatus = async (orderId, newStatus) => {
    try {
        await updateDoc(doc(db, "orders", orderId), { orderStatus: newStatus });
    } catch (e) {
        console.error("Помилка оновлення статусу замовлення:", e);
        alert("Не вдалося оновити статус замовлення.");
    }
};

// Ручне "оплачено" тепер іде через функцію mark-paid (не прямий запис у Firestore):
// вона перевіряє дозволений перехід (fop: pending->paid, cod: prepaid->paid) і пише
// запис в audit_log. Для online-замовлень кнопки немає — підтверджує лише monobank.
window.markOrderPaid = async (orderId) => {
    const res = await callPaymentAdminFn('mark-paid', { orderID: orderId });
    if (!res.ok) {
        console.error('Помилка позначення оплати:', res.error);
        alert(res.error || 'Не вдалося оновити статус оплати.');
    }
};

// Посилання на оплату для клієнта (напр. попередній інвойс прострочений). Сума
// не запитується в адміна — сервер сам бере її з методу оплати замовлення.
window.createPaymentLinkForOrder = async (orderId, btn) => {
    if (btn) { btn.disabled = true; btn.textContent = 'Створюємо…'; }
    const res = await callPaymentAdminFn('create-admin-payment-link', { orderID: orderId });
    if (btn) { btn.disabled = false; btn.textContent = 'Створити посилання на оплату'; }
    if (!res.ok || !res.pageUrl) {
        alert(res.error || 'Не вдалося створити посилання на оплату.');
        return;
    }
    try {
        await navigator.clipboard.writeText(res.pageUrl);
        alert(`Посилання скопійовано в буфер обміну:\n${res.pageUrl}`);
    } catch {
        prompt('Скопіюйте посилання на оплату:', res.pageUrl);
    }
};

// Повне повернення коштів. Сума не запитується — сервер бере її з payments/{invoiceId}.
// Підтвердження номером замовлення — додатковий бар'єр перед грошовою операцією
// (архітектурний опис, 8.1).
window.refundOrderPayment = async (orderId, invoiceId, orderNum, btn) => {
    const typed = prompt(`Щоб підтвердити повне повернення коштів, введіть номер замовлення (${orderNum}):`);
    if (typed === null) return;
    if (typed.trim() !== orderNum) { alert('Номер замовлення не збігається. Повернення скасовано.'); return; }
    const reason = prompt('Причина повернення (обов’язково):');
    if (!reason || !reason.trim()) { alert('Повернення без причини неможливе.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Повертаємо…'; }
    const res = await callPaymentAdminFn('cancel-payment', { orderID: orderId, invoiceId, reason: reason.trim() });
    if (btn) { btn.disabled = false; btn.textContent = 'Повернути кошти'; }
    if (!res.ok) {
        alert(res.error || 'Не вдалося виконати повернення коштів.');
        return;
    }
    alert('Повернення коштів надіслано в monobank. Статус оновиться автоматично протягом кількох хвилин.');
};

const REVIEW_SOURCE_LABELS = { instagram: 'Instagram', telegram: 'Telegram', google: 'Google', site: 'Сайт' };

window.uploadReview = async () => {
    const status = document.getElementById('reviewStatus');
    const submitBtn = document.querySelector('#tab-reviews .admin-form .order-btn');

    const name = document.getElementById('reviewName').value.trim();
    const text = document.getElementById('reviewText').value.trim();
    const rating = Number(document.getElementById('reviewRating').value);
    const source = document.getElementById('reviewSource').value;
    const instagramLink = document.getElementById('reviewLink').value.trim();
    const published = document.getElementById('reviewPublished').checked;
    const file = document.getElementById('reviewImg').files[0];

    if (!name) return alert("Вкажіть ім'я клієнта!");
    if (!text) return alert("Вкажіть текст відгуку!");

    submitBtn.disabled = true;

    try {
        let image = '';
        if (file) {
            status.textContent = "Стиснення фото...";
            const compressedBlob = await compressImage(file);
            const fileName = `${Date.now()}_${file.name.replace(/\.[^/.]+$/, '')}.jpg`;
            const storageRef = ref(storage, `reviews/${fileName}`);
            status.textContent = "Завантаження фото...";
            const snapshot = await uploadBytes(storageRef, compressedBlob);
            image = await getDownloadURL(snapshot.ref);
        }

        status.textContent = "Збереження...";
        await addDoc(collection(db, "reviews"), {
            name, text, rating, image, source, instagramLink,
            productId: null,
            published,
            sortOrder: Date.now(),
            createdAt: new Date()
        });

        status.textContent = "Відгук додано!";
        document.getElementById('reviewName').value = '';
        document.getElementById('reviewText').value = '';
        document.getElementById('reviewRating').value = '5';
        document.getElementById('reviewSource').value = 'instagram';
        document.getElementById('reviewLink').value = '';
        document.getElementById('reviewImg').value = '';
        document.getElementById('reviewPublished').checked = true;
        setTimeout(() => status.textContent = '', 2500);
    } catch (e) {
        console.error("Помилка додавання відгуку:", e);
        status.textContent = "Помилка збереження!";
    } finally {
        submitBtn.disabled = false;
    }
};

function renderStars(rating) {
    return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function renderReviewsList() {
    const listContainer = document.getElementById('admin-reviews-list');
    if (!listContainer) return;

    const q = query(collection(db, "reviews"), orderBy("sortOrder", "desc"));

    onSnapshot(q, (snapshot) => {
        listContainer.innerHTML = '';

        if (snapshot.empty) {
            listContainer.innerHTML = '<p class="empty-msg">Відгуків поки немає.</p>';
            return;
        }

        snapshot.forEach((reviewDoc) => {
            const data = reviewDoc.data();
            const dateStr = data.createdAt?.toDate
                ? data.createdAt.toDate().toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
                : '—';

            const card = document.createElement('div');
            card.className = 'admin-review-card';
            card.innerHTML = `
                <div class="admin-review-stars">${renderStars(data.rating)}</div>
                <p class="admin-review-text">"${escapeHTML(data.text)}"</p>
                <div class="admin-review-meta">
                    <strong>${escapeHTML(data.name)}</strong>
                    <span>${REVIEW_SOURCE_LABELS[data.source] || escapeHTML(data.source)} · ${dateStr}</span>
                </div>
                ${data.image ? `<img src="${escapeHTML(data.image)}" alt="Фото відгуку" class="admin-review-photo">` : ''}
                <div class="admin-review-status ${data.published ? 'published' : 'hidden'}">
                    ${data.published ? '🟢 Опубліковано' : '⚪ Приховано'}
                </div>
                <div class="admin-review-actions">
                    <button class="review-edit-btn" data-id="${reviewDoc.id}">Редагувати</button>
                    <button class="review-delete-btn" data-id="${reviewDoc.id}" data-img="${data.image || ''}">Видалити</button>
                </div>
            `;
            listContainer.appendChild(card);
        });
    });
}

window.deleteReview = async (docId, imageUrl) => {
    if (!confirm("Видалити відгук?")) return;
    try {
        if (imageUrl?.includes("firebasestorage")) {
            await deleteObject(ref(storage, imageUrl));
        }
        await deleteDoc(doc(db, "reviews", docId));
    } catch (e) {
        console.error("Помилка видалення відгуку:", e);
        alert("Не вдалося видалити відгук.");
    }
};

window.openEditReviewModal = async (docId) => {
    const status = document.getElementById('editReviewStatus');
    status.textContent = '';
    try {
        const snap = await getDoc(doc(db, "reviews", docId));
        if (!snap.exists()) return alert("Відгук не знайдено (можливо, вже видалений).");

        const data = snap.data();
        document.getElementById('editReviewDocId').value = docId;
        document.getElementById('editReviewName').value = data.name || '';
        document.getElementById('editReviewText').value = data.text || '';
        document.getElementById('editReviewRating').value = data.rating || 5;
        document.getElementById('editReviewSource').value = data.source || 'instagram';
        document.getElementById('editReviewLink').value = data.instagramLink || '';
        document.getElementById('editReviewPublished').checked = !!data.published;
        document.getElementById('editReviewCurrentImg').src = data.image || '';
        document.getElementById('editReviewImg').value = '';

        document.getElementById('edit-review-modal').style.display = 'flex';
    } catch (e) {
        console.error("Помилка завантаження відгуку для редагування:", e);
        alert("Не вдалося завантажити дані відгуку.");
    }
};

window.closeEditReviewModal = () => {
    document.getElementById('edit-review-modal').style.display = 'none';
};

window.saveReviewEdit = async () => {
    const status = document.getElementById('editReviewStatus');
    const docId = document.getElementById('editReviewDocId').value;
    const saveBtn = document.querySelector('#edit-review-modal .order-btn');

    const name = document.getElementById('editReviewName').value.trim();
    const text = document.getElementById('editReviewText').value.trim();
    const newFile = document.getElementById('editReviewImg').files[0];

    if (!name) return alert("Вкажіть ім'я клієнта!");
    if (!text) return alert("Вкажіть текст відгуку!");

    saveBtn.disabled = true;

    try {
        const updateData = {
            name, text,
            rating: Number(document.getElementById('editReviewRating').value),
            source: document.getElementById('editReviewSource').value,
            instagramLink: document.getElementById('editReviewLink').value.trim(),
            published: document.getElementById('editReviewPublished').checked,
        };

        if (newFile) {
            status.textContent = "Стиснення нового фото...";
            const compressedBlob = await compressImage(newFile);
            const fileName = `${Date.now()}_${newFile.name.replace(/\.[^/.]+$/, '')}.jpg`;
            const storageRef = ref(storage, `reviews/${fileName}`);
            status.textContent = "Завантаження нового фото...";
            const snapshot = await uploadBytes(storageRef, compressedBlob);
            updateData.image = await getDownloadURL(snapshot.ref);

            const oldImage = document.getElementById('editReviewCurrentImg').src;
            if (oldImage?.includes("firebasestorage")) {
                deleteObject(ref(storage, oldImage)).catch(() => {});
            }
        }

        status.textContent = "Збереження...";
        await updateDoc(doc(db, "reviews", docId), updateData);

        status.textContent = "Збережено!";
        setTimeout(() => { closeEditReviewModal(); status.textContent = ''; }, 800);
    } catch (e) {
        console.error("Помилка збереження відгуку:", e);
        status.textContent = "Помилка збереження!";
    } finally {
        saveBtn.disabled = false;
    }
};

// Статичні кнопки адмінки (admin.html) викликаються через data-action замість inline onclick:
// суворий CSP на /admin.html забороняє inline-обробники (script-src без 'unsafe-inline').
// Дозволені лише імена зі списку — довільне значення атрибута функцію не викличе.
const ADMIN_STATIC_ACTIONS = new Set([
    'login', 'logout',
    'uploadProduct', 'saveProductEdit', 'closeEditModal',
    'uploadPackaging', 'savePackagingEdit', 'closeEditPackagingModal',
    'uploadReview', 'saveReviewEdit', 'closeEditReviewModal',
]);

function initAdminStaticActions() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest?.('[data-action]');
        if (!el || !ADMIN_STATIC_ACTIONS.has(el.dataset.action)) return;
        // Функції оголошені як window.<name> вище; шукаємо їх у момент кліку, а не при
        // завантаженні модуля, щоб відсутня функція не ламала весь script.js (і публічний сайт).
        const fn = window[el.dataset.action];
        if (typeof fn === 'function') fn();
    });
}

function initAdminTabs() {
    const tabButtons = document.querySelectorAll('.admin-tab-btn');
    if (!tabButtons.length) return;

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            document.querySelectorAll('.admin-tab-panel').forEach(panel => panel.hidden = true);
            document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
        });
    });

    document.getElementById('orderStatusFilter')?.addEventListener('change', renderOrdersList);

    document.getElementById('admin-orders-list')?.addEventListener('change', (e) => {
        if (e.target.classList.contains('order-status-select')) {
            updateOrderStatus(e.target.dataset.id, e.target.value);
        }
    });

    document.getElementById('admin-orders-list')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('mark-paid-btn')) {
            markOrderPaid(e.target.dataset.id);
        } else if (e.target.classList.contains('payment-link-btn')) {
            createPaymentLinkForOrder(e.target.dataset.id, e.target);
        } else if (e.target.classList.contains('refund-payment-btn')) {
            refundOrderPayment(e.target.dataset.id, e.target.dataset.invoice, e.target.dataset.orderNum, e.target);
        }
    });
}


function renderAdminList() {
    const listContainer = document.getElementById('admin-product-list');
    if (!listContainer) return;

    // Отримуємо значення фільтрів
    const searchVal = document.getElementById('searchArticul')?.value.toLowerCase() || "";
    const categoryVal = document.getElementById('filterCategory')?.value || "all";

    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
    
    onSnapshot(q, (snapshot) => {
        const fragment = document.createDocumentFragment();
        
        snapshot.forEach((productDoc) => {
            const data = productDoc.data();
            
            // Логіка фільтрації
            const matchesSearch = (data.id || "").toLowerCase().includes(searchVal);
            const matchesCategory = (categoryVal === "all") || (data.category === categoryVal);

            if (matchesSearch && matchesCategory) {
                const safeTitle = escapeHTML(data.title);
                const safeId = escapeHTML(data.id) || '—';
                const safeCategory = escapeHTML(data.category) || '—';

                const item = document.createElement('div');
                item.className = 'admin-product-item';
                
                item.innerHTML = `
                    <div class="admin-item-info">
                        <img src="${escapeHTML(data.image)}" class="admin-item-thumb" loading="lazy">
                        <div class="admin-item-text">
                            <span class="admin-item-title">${safeTitle}</span>
                            <span class="admin-item-sku">Артикул: ${safeId}</span>
                            <span class="admin-item-category" style="font-size: 0.85em; color: #666;">Категорія: ${safeCategory}</span>
                        </div>
                    </div>
                    <div class="admin-item-actions">
                        <span class="admin-item-price">${data.price} грн</span>
                        <button class="stock-btn ${data.inStock === false ? '' : 'active'}" data-id="${productDoc.id}" data-instock="${data.inStock !== false}" title="В наявності">📦</button>
                        <button class="star-btn ${data.featured ? 'active' : ''}" data-id="${productDoc.id}" data-featured="${!!data.featured}" title="Показувати в 'Популярних'">★</button>
                        <button class="edit-btn" data-id="${productDoc.id}" title="Редагувати товар">✏️</button>
                        <button class="delete-btn" data-id="${productDoc.id}" data-img="${data.image}" title="Видалити">🗑</button>
                    </div>
                `;
                fragment.appendChild(item);
            }
        });

        listContainer.innerHTML = '';
        listContainer.appendChild(fragment);
    });
}

// --- 3. ЗАГАЛЬНІ ФУНКЦІЇ ---
let currentFilter = 'all';
let currentPage = 1;

function initFilters() {
    const filterButtons = document.querySelectorAll('.filter-btn');
    const sortSelect = document.getElementById('sort-select');

    // Якщо прийшли з головної з обраною категорією (catalog.html?category=Каблучки)
    const urlCategory = new URLSearchParams(window.location.search).get('category');
    if (urlCategory && filterButtons.length) {
        const match = Array.from(filterButtons).find(btn => btn.dataset.filter.toLowerCase() === urlCategory.toLowerCase());
        if (match) {
            document.querySelector('.filter-btn.active')?.classList.remove('active');
            match.classList.add('active');
            currentFilter = urlCategory.toLowerCase();
        }
    }

    filterButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            document.querySelector('.filter-btn.active')?.classList.remove('active');
            e.target.classList.add('active');
            currentFilter = e.target.dataset.filter.toLowerCase();
            currentPage = 1; // при зміні категорії завжди починаємо з першої сторінки
            renderCatalog();
        });
    });

    sortSelect?.addEventListener('change', () => {
        currentPage = 1;
        renderCatalog();
    });
}

// Плитки категорій на головній — ведуть на сторінку каталогу з обраною категорією
function initCategoryTiles() {
    const tiles = document.querySelectorAll('.category-tile');
    tiles.forEach(tile => {
        tile.addEventListener('click', () => {
            window.location.href = `catalog.html?category=${encodeURIComponent(tile.dataset.filter)}`;
        });
    });
}

// Делегування подій для кнопок "У кошик", "Редагувати" та "Видалити"
document.addEventListener('click', (e) => {
    // Кнопка "У кошик" на клієнті
    if (e.target.closest('.cart-btn')) {
        const btn = e.target.closest('.cart-btn');
        window.addToCart?.({
            id: btn.dataset.id,
            title: btn.dataset.title,
            price: Number(btn.dataset.price),
            image: btn.dataset.image,
            category: btn.dataset.category || ''
        });
        // Коротка візуальна відповідь, що товар додано
        const originalText = btn.textContent;
        btn.textContent = 'Додано ✓';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1200);
    }
    // Кнопки адмінки — пакування (перевіряємо ПЕРЕД товарними .stock-btn/.star-btn/.edit-btn/.delete-btn,
    // бо кнопки пакування навмисно розділяють ті самі CSS-класи для однакового вигляду)
    if (e.target.closest('.packaging-active-btn')) {
        const btn = e.target.closest('.packaging-active-btn');
        togglePackagingActive(btn.dataset.id, btn.dataset.active === 'true');
        return;
    }
    if (e.target.closest('.packaging-default-btn')) {
        const btn = e.target.closest('.packaging-default-btn');
        setPackagingDefault(btn.dataset.id, btn.dataset.isdefault === 'true');
        return;
    }
    if (e.target.closest('.packaging-edit-btn')) {
        const btn = e.target.closest('.packaging-edit-btn');
        openEditPackagingModal(btn.dataset.id);
        return;
    }
    if (e.target.closest('.packaging-delete-btn')) {
        const btn = e.target.closest('.packaging-delete-btn');
        deletePackaging(btn.dataset.id, btn.dataset.packid, btn.dataset.img);
        return;
    }
    // Кнопки адмінки
    if (e.target.closest('.stock-btn')) {
        const btn = e.target.closest('.stock-btn');
        toggleInStock(btn.dataset.id, btn.dataset.instock === 'true');
    }
    if (e.target.closest('.star-btn')) {
        const btn = e.target.closest('.star-btn');
        toggleFeatured(btn.dataset.id, btn.dataset.featured === 'true');
    }
    if (e.target.closest('.edit-btn')) {
        const btn = e.target.closest('.edit-btn');
        openEditModal(btn.dataset.id);
    }
    if (e.target.closest('.delete-btn')) {
        const btn = e.target.closest('.delete-btn');
        deleteProduct(btn.dataset.id, btn.dataset.img);
    }
    if (e.target.closest('.review-edit-btn')) {
        const btn = e.target.closest('.review-edit-btn');
        openEditReviewModal(btn.dataset.id);
    }
    if (e.target.closest('.review-delete-btn')) {
        const btn = e.target.closest('.review-delete-btn');
        deleteReview(btn.dataset.id, btn.dataset.img);
    }
});

// Акордеон (FAQ)
document.querySelectorAll('.accordion-item').forEach(item => {
    const question = item.querySelector('.accordion-question');
    question?.addEventListener('click', () => {
        document.querySelectorAll('.accordion-item').forEach(otherItem => {
            if (otherItem !== item) otherItem.classList.remove('active');
        });
        item.classList.toggle('active');
    });
});

// Модальне вікно замовлення — приймає готовий текст повідомлення й короткий підсумок для показу
window.openOrderModal = (summaryText, messageText) => {
    const modalInfo = document.getElementById('modal-product-info');
    if (modalInfo) modalInfo.textContent = summaryText;

    const encodedMessage = encodeURIComponent(messageText);
    document.getElementById('btn-tg').href = `https://t.me/${CONTACT_INFO.tgUsername}?text=${encodedMessage}`;
    document.getElementById('btn-vb').href = `viber://chat?number=${CONTACT_INFO.phoneNumber.replace('+', '%2B')}`;

    document.getElementById('order-modal').style.display = 'flex';
};

window.closeOrderModal = () => document.getElementById('order-modal').style.display = 'none';

// Ініціалізація при завантаженні DOM
document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderProducts();
    renderPublicReviews();
    initFilters();
    initCategoryTiles();
    initProductPage();
    initAdminTabs();
    initAdminStaticActions();
    initCheckoutPackaging();
    
    const burger = document.querySelector('.burger');
    const nav = document.querySelector('.nav-links');
    burger?.addEventListener('click', () => {
        burger.classList.toggle('active');
        nav.classList.toggle('active');
    });
    const searchInput = document.getElementById('searchArticul');
    const categorySelect = document.getElementById('filterCategory');

    if (searchInput) {
        searchInput.addEventListener('input', renderAdminList);
    }
    if (categorySelect) {
        categorySelect.addEventListener('change', renderAdminList);
    }
});

// Swiper
if (typeof Swiper !== 'undefined') {
    new Swiper(".mySwiper", {
        loop: true,
        autoplay: { delay: 3000, disableOnInteraction: false },
        effect: 'fade',
        fadeEffect: { crossFade: true }
    });
}

// База даних проєктів (Portfolio)
const projectsData = {
    project1: {
        title: "Проєкт 'Назва 1'",
        description: "Це детальний опис проєкту. Ми реалізували повний цикл розробки — від ідеї до фінального запуску. Використано технології HTML5, CSS3 та JavaScript.",
        results: "Завдяки нашому рішенню, клієнт отримав приріст нових користувачів на 45% за перший місяць.",
        images: ["https://picsum.photos/800/600?random=1"]
    }
};

window.openModal = (id) => {
    const data = projectsData[id];
    if (!data) return;

    const modalBody = document.getElementById('modalBody');
    const modal = document.getElementById('projectModal');

    const galleryHtml = data.images.map(img => `
        <a href="${img}" class="glightbox"><img src="${img}" alt="деталь фото" loading="lazy"></a>
    `).join('');

    // Використовуємо textContent через DOM API для безпеки або санітизуємо
    modalBody.innerHTML = `
        <h2 style="margin-top:0">${escapeHTML(data.title)}</h2>
        <p style="font-size: 1.1rem; line-height: 1.6; color: #444;">${escapeHTML(data.description)}</p>
        <div style="background: #eef6ff; padding: 15px; border-radius: 10px; border-left: 5px solid #007bff;">
            <strong>Результат:</strong> ${escapeHTML(data.results)}
        </div>
        <h4 style="margin-top: 30px;">Галерея робіт (клікніть для перегляду):</h4>
        <div class="modal-gallery">${galleryHtml}</div>
    `;

    modal.style.display = 'flex';

    if (typeof GLightbox !== 'undefined') {
        GLightbox({ selector: '.glightbox', touchNavigation: true, loop: true });
    }
};

window.closeModal = () => document.getElementById('projectModal').style.display = 'none';

window.addEventListener('click', (event) => {
    const modal = document.getElementById('projectModal');
    if (event.target === modal) closeModal();
});

// Кнопка Back to Top з троттлінгом (Throttling) для оптимізації скролу
const backToTop = document.getElementById('back-to-top');
if (backToTop) {
    let isScrolling = false;
    window.addEventListener('scroll', () => {
        if (!isScrolling) {
            window.requestAnimationFrame(() => {
                backToTop.classList.toggle('show', window.scrollY > 300);
                isScrolling = false;
            });
            isScrolling = true;
        }
    }, { passive: true });

    backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// --- Cookie Consent Banner ---
// Згода зберігається через SilveriAnalytics.setConsent (analytics.js): «Прийняти» / «Відхилити».
// Якщо analytics.js на сторінці немає (admin.html) — працює як раніше, з однією кнопкою.
(function initCookieBanner() {
    const LEGACY_KEY = 'silveri_cookie_consent';
    const A = window.SilveriAnalytics;

    if (A) {
        if (A.getConsent() !== 'unset') return; // рішення вже прийнято
    } else if (localStorage.getItem(LEGACY_KEY) === 'accepted') {
        return;
    }

    const banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-live', 'polite');
    banner.setAttribute('aria-label', 'Повідомлення про використання файлів cookie');
    banner.innerHTML = `
        <span class="cookie-banner__icon" aria-hidden="true">🍪</span>
        <p class="cookie-banner__text">
            Ми використовуємо файли cookie. Вони потрібні для коректної роботи сайту та покращення вашого досвіду.
            <a href="privacy.html">Політика конфіденційності</a>
        </p>
        <div class="cookie-banner__actions">
            ${A ? '<button type="button" class="cookie-banner__btn cookie-banner__btn--secondary" data-consent="denied">Відхилити</button>' : ''}
            <button type="button" class="cookie-banner__btn" data-consent="granted">Прийняти</button>
        </div>
    `;
    document.body.appendChild(banner);

    requestAnimationFrame(() => banner.classList.add('show'));

    banner.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-consent]');
        if (!btn) return;
        if (A) A.setConsent(btn.dataset.consent);
        else localStorage.setItem(LEGACY_KEY, 'accepted');
        banner.classList.remove('show');
        setTimeout(() => banner.remove(), 400);
    });
})();
