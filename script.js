import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);

const CONTACT_INFO = {
    tgUsername: "solomia_ka",
    igUsername: "silveri_jewelry_ua",
    phoneNumber: "+380680243337"
};

// --- УТИЛІТИ ---
// Захист від XSS-атак при вставці даних у DOM
const escapeHTML = (str) => typeof str === 'string' 
    ? str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[tag]) 
    : str;

// --- 1. КЛІЄНТСЬКА ЧАСТИНА (ГОЛОВНА) ---
function fetchAndRenderProducts() {
    const grid = document.getElementById('product-grid');
    if (!grid) return;

    grid.innerHTML = '<p class="loading-msg">Завантаження колекції...</p>';
    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));

    onSnapshot(q, (snapshot) => {
        if (snapshot.empty) {
            grid.innerHTML = '<p class="empty-msg">Товарів поки немає.</p>';
            return;
        }

        // Використовуємо DocumentFragment для мінімізації Reflow/Repaint DOM
        const fragment = document.createDocumentFragment();

        snapshot.forEach((doc) => {
            const { id, title, description, price, image, category } = doc.data();
            const safeTitle = escapeHTML(title);
            const safeDesc = escapeHTML(description);
            const safeId = escapeHTML(id);
            const safeImage = escapeHTML(image) || 'img/placeholder.jpg';
            const safeCategory = (category || "").toLowerCase();

            const card = document.createElement('div');
            card.className = 'product-card';
            card.dataset.category = safeCategory;
            
            card.innerHTML = `
                <div class="product-id">Артикул: ${safeId || '---'}</div>
                <div class="product-img">
                    <img src="${safeImage}" alt="${safeTitle}" loading="lazy">
                </div>
                <h3>${safeTitle}</h3>
                <p class="product-desc">${safeDesc}</p>
                <p class="price">${price} грн</p>
                <button class="order-btn" data-title="${safeTitle}" data-price="${price}">Замовити</button>
            `;
            fragment.appendChild(card);
        });

        grid.innerHTML = ''; 
        grid.appendChild(fragment);
        applyCurrentFilter(); // Застосовуємо активний фільтр без переприв'язки подій
    });
}

// --- 2. АДМІН-ЧАСТИНА (ЛОГІКА) ---
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
        if (isLoggedIn) renderAdminList();
    }
});

window.uploadProduct = async () => {
    const status = document.getElementById('status');
    const fileInput = document.getElementById('prodImg');
    const form = document.querySelector('.admin-form');
    const file = fileInput.files[0];
    
    if (!file) return alert("Оберіть фото!");

    status.textContent = "Завантаження...";
    try {
        const fileName = `${Date.now()}_${file.name}`;
        const storageRef = ref(storage, `products/${fileName}`);
        const snapshot = await uploadBytes(storageRef, file);
        const downloadURL = await getDownloadURL(snapshot.ref);

        await addDoc(collection(db, "products"), {
            id: document.getElementById('prodId').value.trim(),
            title: document.getElementById('prodTitle').value.trim(),
            price: Number(document.getElementById('prodPrice').value),
            category: document.getElementById('prodCategory').value,
            description: document.getElementById('prodDesc').value.trim(),
            image: downloadURL,
            createdAt: new Date()
        });
        
        status.textContent = "Товар успішно додано!";
        form.reset();
        setTimeout(() => status.textContent = "", 3000); // Очищення статусу
    } catch (e) {
        status.textContent = "Помилка завантаження!";
        console.error(e);
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

window.editPrice = async (docId, currentPrice) => {
    const newPrice = prompt(`Змінити ціну (зараз: ${currentPrice} грн):`, currentPrice);
    const parsedPrice = Number(newPrice);
    
    if (newPrice !== null && newPrice.trim() !== "" && !isNaN(parsedPrice)) {
        try {
            await updateDoc(doc(db, "products", docId), { price: parsedPrice });
        } catch (e) {
            console.error("Помилка оновлення ціни:", e);
            alert("Не вдалося оновити ціну.");
        }
    } else if (newPrice !== null) {
        alert("Будь ласка, введіть коректне число!");
    }
};

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
                        <button class="edit-btn" data-id="${productDoc.id}" data-price="${data.price}" title="Редагувати ціну">✏️</button>
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

function initFilters() {
    const filterButtons = document.querySelectorAll('.filter-btn');
    if (!filterButtons.length) return;

    // Використовуємо делегування подій на батьківський контейнер (якщо він є), 
    // або додаємо слухачі ОДИН раз
    filterButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            document.querySelector('.filter-btn.active')?.classList.remove('active');
            e.target.classList.add('active');
            currentFilter = e.target.dataset.filter.toLowerCase();
            applyCurrentFilter();
        });
    });
}

function applyCurrentFilter() {
    const products = document.querySelectorAll('.product-card');
    products.forEach(product => {
        const category = product.dataset.category;
        product.style.display = (currentFilter === 'all' || category === currentFilter) ? 'flex' : 'none';
    });
}

// Делегування подій для кнопок "Замовити", "Редагувати" та "Видалити"
document.addEventListener('click', (e) => {
    // Кнопка "Замовити" на клієнті
    if (e.target.closest('.order-btn')) {
        const btn = e.target.closest('.order-btn');
        openOrderModal(btn.dataset.title, btn.dataset.price);
    }
    // Кнопки адмінки
    if (e.target.closest('.edit-btn')) {
        const btn = e.target.closest('.edit-btn');
        editPrice(btn.dataset.id, btn.dataset.price);
    }
    if (e.target.closest('.delete-btn')) {
        const btn = e.target.closest('.delete-btn');
        deleteProduct(btn.dataset.id, btn.dataset.img);
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

// Модальне вікно замовлення
window.openOrderModal = (title, price) => {
    const modalInfo = document.getElementById('modal-product-info');
    if(modalInfo) modalInfo.textContent = `${title} — ${price} грн`;
    
    const textMessage = encodeURIComponent(`Добрий день! Хочу замовити:\n${title}\nЦіна: ${price} грн.`);
    
    document.getElementById('btn-tg').href = `https://t.me/${CONTACT_INFO.tgUsername}?text=${textMessage}`;
    document.getElementById('btn-vb').href = `viber://chat?number=${CONTACT_INFO.phoneNumber.replace('+', '%2B')}`;
    document.getElementById('btn-ig').href = `https://instagram.com/${CONTACT_INFO.igUsername}`;
    document.getElementById('order-modal').style.display = 'flex';
};

window.closeOrderModal = () => document.getElementById('order-modal').style.display = 'none';

// Ініціалізація при завантаженні DOM
document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderProducts();
    initFilters();
    
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