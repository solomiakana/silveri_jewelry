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

// --- 1. КЛІЄНТСЬКА ЧАСТИНА (ГОЛОВНА) ---
async function fetchAndRenderProducts() {
    const grid = document.getElementById('product-grid');
    if (!grid) return;

    grid.innerHTML = '<p style="text-align: center; width: 100%;">Завантаження колекції...</p>';
    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));

    onSnapshot(q, (snapshot) => {
        grid.innerHTML = ''; 
        if (snapshot.empty) {
            grid.innerHTML = '<p style="text-align: center; width: 100%;">Товарів поки немає.</p>';
            return;
        }

        snapshot.forEach((doc) => {
            const product = doc.data();
            const card = document.createElement('div');
            card.className = 'product-card';
            card.setAttribute('data-category', (product.category || "").toLowerCase());
            
            card.innerHTML = `
                <div class="product-id">Артикул: ${product.id || '---'}</div>
                <div class="product-img">
                    <img src="${product.image || 'img/placeholder.jpg'}" alt="${product.title}" loading="lazy">
                </div>
                <h3>${product.title}</h3>
                <p class="product-desc">${product.description || ''}</p>
                <p class="price">${product.price} грн</p>
                <button class="order-btn" onclick="openOrderModal('${product.title.replace(/'/g, "\\'")}', '${product.price}')">Замовити</button>
            `;
            grid.appendChild(card);
        });
        initFilters();
    });
}

// --- 2. АДМІН-ЧАСТИНА (ЛОГІКА) ---

// Вхід
window.login = () => {
    const email = document.getElementById('adminEmail').value;
    const pass = document.getElementById('adminPass').value;
    const errorP = document.getElementById('login-error');

    if (!email || !pass) {
        errorP.innerText = "Заповніть всі поля!";
        return;
    }

    signInWithEmailAndPassword(auth, email, pass)
        .then(() => {
            errorP.innerText = "";
        })
        .catch(error => {
            console.error("Код помилки:", error.code);
            errorP.innerText = "Помилка: невірний логін або пароль.";
        });
};

// Вихід
window.logout = () => signOut(auth);

// Перевірка стану авторизації
onAuthStateChanged(auth, (user) => {
    const loginScreen = document.getElementById('login-screen');
    const adminPanel = document.getElementById('admin-panel');

    if (adminPanel && loginScreen) { // Перевірка чи на сторінці адмінки
        if (user) {
            loginScreen.style.display = 'none';
            adminPanel.style.display = 'block';
            renderAdminList();
        } else {
            loginScreen.style.display = 'flex';
            adminPanel.style.display = 'none';
        }
    }
});

// Завантаження товару
window.uploadProduct = async () => {
    const status = document.getElementById('status');
    const file = document.getElementById('prodImg').files[0];
    if (!file) return alert("Оберіть фото!");

    status.innerText = "Завантаження...";
    try {
        const fileName = Date.now() + "_" + file.name;
        const storageRef = ref(storage, 'products/' + fileName);
        const snapshot = await uploadBytes(storageRef, file);
        const downloadURL = await getDownloadURL(snapshot.ref);

        await addDoc(collection(db, "products"), {
            id: document.getElementById('prodId').value,
            title: document.getElementById('prodTitle').value,
            price: document.getElementById('prodPrice').value,
            category: document.getElementById('prodCategory').value,
            description: document.getElementById('prodDesc').value,
            image: downloadURL,
            createdAt: new Date()
        });
        status.innerText = "Товар успішно додано!";
        document.querySelector('.admin-form').reset();
    } catch (e) {
        status.innerText = "Помилка!";
        console.error(e);
    }
};

// Видалення товару
window.deleteProduct = async (docId, imageUrl) => {
    if (!confirm("Видалити товар?")) return;
    try {
        if (imageUrl && imageUrl.includes("firebasestorage")) {
            await deleteObject(ref(storage, imageUrl));
        }
        await deleteDoc(doc(db, "products", docId));
    } catch (error) { console.error(error); }
};

// ФУНКЦІЯ РЕДАГУВАННЯ ЦІНИ
window.editPrice = async (docId, currentPrice) => {
    const newPrice = prompt(`Змінити ціну (зараз: ${currentPrice} грн):`, currentPrice);
    
    // Перевіряємо, чи користувач ввів число і не натиснув "Скасувати"
    if (newPrice !== null && newPrice !== "" && !isNaN(newPrice)) {
        try {
            const productRef = doc(db, "products", docId);
            await updateDoc(productRef, {
                price: Number(newPrice)
            });
        } catch (e) {
            console.error("Помилка оновлення ціни:", e);
            alert("Не вдалося оновити ціну.");
        }
    } else if (newPrice !== null && isNaN(newPrice)) {
        alert("Будь ласка, введіть коректне число!");
    }
};

// Список товарів в адмінці
function renderAdminList() {
    const listContainer = document.getElementById('admin-product-list');
    if (!listContainer) return;

    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
    onSnapshot(q, (snapshot) => {
        listContainer.innerHTML = '';
        snapshot.forEach((productDoc) => {
            const data = productDoc.data();
            const item = document.createElement('div');
            item.className = 'admin-product-item';
            
            item.innerHTML = `
                <div class="admin-item-info">
                    <img src="${data.image}" class="admin-item-thumb">
                    <div class="admin-item-text">
                        <span class="admin-item-title">${data.title}</span>
                        <span class="admin-item-sku">Артикул: ${data.id || '—'}</span>
                        <span class="admin-item-category" style="font-size: 0.85em; color: #666;">Категорія: ${data.category || '—'}</span>
                    </div>
                </div>
                <div class="admin-item-actions">
                    <span class="admin-item-price">${data.price} грн</span>
                    <button class="edit-btn" onclick="editPrice('${productDoc.id}', '${data.price}')" title="Редагувати ціну">✏️</button>
                    <button class="delete-btn" onclick="deleteProduct('${productDoc.id}', '${data.image}')" title="Видалити">🗑</button>
                </div>
            `;
            listContainer.appendChild(item);
        });
    });
}

// --- 3. ЗАГАЛЬНІ ФУНКЦІЇ ---
function initFilters() {
    const filterButtons = document.querySelectorAll('.filter-btn');
    const products = document.querySelectorAll('.product-card');

    filterButtons.forEach(button => {
        button.addEventListener('click', () => {
            document.querySelector('.filter-btn.active')?.classList.remove('active');
            button.classList.add('active');
            const filter = button.getAttribute('data-filter').toLowerCase();

            products.forEach(product => {
                const category = product.getAttribute('data-category');
                product.style.display = (filter === 'all' || category === filter) ? 'flex' : 'none';
            });
        });
    });
}

// Логіка для акордеона (FAQ)
const accordionItems = document.querySelectorAll('.accordion-item');

accordionItems.forEach(item => {
    const question = item.querySelector('.accordion-question');
    question.addEventListener('click', () => {
        accordionItems.forEach(otherItem => {
            if (otherItem !== item) otherItem.classList.remove('active');
        });
        item.classList.toggle('active');
    });
});

//модальне вікно
window.openOrderModal = function(title, price) {
    const modalInfo = document.getElementById('modal-product-info');
    if(modalInfo) modalInfo.innerText = `${title} — ${price} грн`;
    const textMessage = encodeURIComponent(`Добрий день! Хочу замовити:\n${title}\nЦіна: ${price} грн.`);
    
    document.getElementById('btn-tg').href = `https://t.me/${CONTACT_INFO.tgUsername}?text=${textMessage}`;
    document.getElementById('btn-vb').href = `viber://chat?number=${CONTACT_INFO.phoneNumber.replace('+', '%2B')}`;
    document.getElementById('btn-ig').href = `https://instagram.com/${CONTACT_INFO.igUsername}`;
    document.getElementById('order-modal').style.display = 'flex';
}

window.closeOrderModal = () => document.getElementById('order-modal').style.display = 'none';

document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderProducts();
    
    const burger = document.querySelector('.burger');
    const nav = document.querySelector('.nav-links');
    if (burger && nav) {
        burger.addEventListener('click', () => {
            burger.classList.toggle('active');
            nav.classList.toggle('active');
        });
    }
});

// 1. Ініціалізація автоматичного гортання фото в картках
const swiper = new Swiper(".mySwiper", {
    loop: true,
    autoplay: {
        delay: 3000,
        disableOnInteraction: false,
    },
    effect: 'fade', // Плавний перехід між фото
    fadeEffect: { crossFade: true }
});

// 2. База даних твоїх проєктів
const projectsData = {
    project1: {
        title: "Проєкт 'Назва 1'",
        description: "Це детальний опис проєкту. Ми реалізували повний цикл розробки — від ідеї до фінального запуску. Використано технології HTML5, CSS3 та JavaScript.",
        results: "Завдяки нашому рішенню, клієнт отримав приріст нових користувачів на 45% за перший місяць.",
        images: [
            "https://picsum.photos/800/600?random=1",
            "https://picsum.photos/800/600?random=2",
            "https://picsum.photos/800/600?random=3",
            "https://picsum.photos/800/600?random=4"
        ]
    }
    // Сюди додавай project2, project3 і так далі...
};

// 3. Функція відкриття модального вікна
function openModal(id) {
    const data = projectsData[id];
    const modalBody = document.getElementById('modalBody');
    const modal = document.getElementById('projectModal');

    // Формуємо HTML для галереї всередині модалки
    let galleryHtml = data.images.map(img => `
        <a href="${img}" class="glightbox">
            <img src="${img}" alt="деталь фото">
        </a>
    `).join('');

    // Наповнюємо модалку контентом
    modalBody.innerHTML = `
        <h2 style="margin-top:0">${data.title}</h2>
        <p style="font-size: 1.1rem; line-height: 1.6; color: #444;">${data.description}</p>
        <div style="background: #eef6ff; padding: 15px; border-radius: 10px; border-left: 5px solid #007bff;">
            <strong>Результат:</strong> ${data.results}
        </div>
        <h4 style="margin-top: 30px;">Галерея робіт (клікніть для перегляду):</h4>
        <div class="modal-gallery">${galleryHtml}</div>
    `;

    // Показуємо вікно
    modal.style.display = 'flex';

    // Активуємо GLightbox для новостворених картинок
    const lightbox = GLightbox({
        selector: '.glightbox',
        touchNavigation: true,
        loop: true
    });
}

// 4. Функція закриття
function closeModal() {
    document.getElementById('projectModal').style.display = 'none';
}

// Закриття при кліку на фон
window.onclick = function(event) {
    const modal = document.getElementById('projectModal');
    if (event.target == modal) closeModal();
}