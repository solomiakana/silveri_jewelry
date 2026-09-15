import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, getDoc, onSnapshot, query, orderBy, where, getDocs, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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
initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6Lc7m7wtAAAAALbkOTY1oe28WmkfIgMxdZJ-yyqz'),
    isTokenAutoRefreshEnabled: true
});

const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);


const CONTACT_INFO = {
    tgUsername: "solomia_ka",
    phoneNumber: "+380680243337"
};

// --- УТИЛІТИ ---
// Захист від XSS-атак при вставці даних у DOM
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
        <button class="cart-btn" data-id="${safeId}" data-title="${safeTitle}" data-price="${price}" data-image="${safeImage}" ${outOfStock ? 'disabled' : ''}>
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
                    <button class="cart-btn" data-id="${safeId}" data-title="${safeTitle}" data-price="${price}" data-image="${safeImage}" ${outOfStock ? 'disabled' : ''}>
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

const ORDER_STATUS_LABELS = {
    new: 'Нове',
    processing: 'В обробці',
    shipped: 'Відправлено',
    done: 'Виконано',
    cancelled: 'Скасовано'
};

const DELIVERY_TYPE_LABELS = { nova_poshta: 'Нова Пошта' };
const DELIVERY_FORMAT_LABELS = { branch: 'Відділення', postomat: 'Поштомат' };
const PAYMENT_METHOD_LABELS = { cod: 'Накладений платіж', fop: 'Повна оплата (ФОП)', wayforpay: 'WayForPay (онлайн)' };

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
            const paymentBadge = paymentStatus === 'paid'
                ? '<span class="payment-badge paid">🟢 Оплачено</span>'
                : `<span class="payment-badge pending">⏳ ${data.paymentMethod === 'cod' ? 'Накладений платіж' : 'Очікує оплату'}</span>`;

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
                <div class="admin-order-customer">
                    <strong>${escapeHTML(data.customerName)}</strong> · <a href="tel:${escapeHTML(data.customerPhone)}">${escapeHTML(data.customerPhone)}</a>
                </div>
                <div class="admin-order-delivery">🚚 ${deliveryLabel}</div>
                <div class="admin-order-payment">
                    💳 ${paymentLabel} ${paymentBadge}
                    ${paymentStatus !== 'paid' ? `<button class="mark-paid-btn" data-id="${orderDoc.id}">Позначити оплаченим</button>` : ''}
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

window.markOrderPaid = async (orderId) => {
    try {
        await updateDoc(doc(db, "orders", orderId), { paymentStatus: 'paid' });
    } catch (e) {
        console.error("Помилка позначення оплати:", e);
        alert("Не вдалося оновити статус оплати.");
    }
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
            image: btn.dataset.image
        });
        // Коротка візуальна відповідь, що товар додано
        const originalText = btn.textContent;
        btn.textContent = 'Додано ✓';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1200);
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
(function initCookieBanner() {
    const STORAGE_KEY = 'silveri_cookie_consent';
    if (localStorage.getItem(STORAGE_KEY) === 'accepted') return;

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
        <button type="button" class="cookie-banner__btn">Прийняти</button>
    `;
    document.body.appendChild(banner);

    requestAnimationFrame(() => banner.classList.add('show'));

    banner.querySelector('.cookie-banner__btn').addEventListener('click', () => {
        localStorage.setItem(STORAGE_KEY, 'accepted');
        banner.classList.remove('show');
        setTimeout(() => banner.remove(), 400);
    });
})();
