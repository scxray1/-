// ⚠️ 請將此網址替換為您最新部署的 Google Apps Script 網址
const API_URL = 'https://script.google.com/macros/s/AKfycbwFulcp6p61Yo-QiK8JtUS49oONkSwzJKZLtPmRr0qyALbDbYQZ-nt2BiU9xJ1XSievXg/exec';

// 配置選項
const CONFIG = {
    CACHE_DURATION: 30000, // 30秒緩存
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000,
    PAGE_SIZE: 20,
    DEBOUNCE_DELAY: 300
};

// 全域變數
let callRecords = [];
let filteredRecords = [];
let currentPage = 1;
let isOnline = navigator.onLine;
let lastCacheTime = 0;
let isLoading = false;

// DOM 元素
const elements = {
    callForm: document.getElementById('callForm'),
    recordsList: document.getElementById('recordsList'),
    searchBox: document.getElementById('searchBox'),
    statusFilter: document.getElementById('statusFilter'),
    connectionStatus: document.getElementById('connectionStatus'),
    offlineBanner: document.getElementById('offlineBanner'),
    submitBtn: document.getElementById('submitBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    // 統計元素
    totalCalls: document.getElementById('totalCalls'),
    pendingCalls: document.getElementById('pendingCalls'),
    resolvedCalls: document.getElementById('resolvedCalls'),
    todayCalls: document.getElementById('todayCalls'),
    // 分頁元素
    paginationInfo: document.getElementById('paginationInfo'),
    pageInfo: document.getElementById('pageInfo'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn')
};

// 工具函數
const utils = {
    // 防抖函數
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    // 格式化日期時間
    formatDateTime(dateTimeString) {
        if (!dateTimeString) return '未設定';
        const date = new Date(dateTimeString);
        return date.toLocaleString('zh-TW', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    // 檢查是否為今天
    isToday(dateString) {
        if (!dateString) return false;
        const today = new Date();
        const date = new Date(dateString);
        return date.toDateString() === today.toDateString();
    },

    // 生成唯一ID
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    // 驗證電話號碼
    validatePhone(phone) {
        const phoneRegex = /^[\d\-\(\)\+\s]+$/;
        return phoneRegex.test(phone) && phone.length >= 8;
    }
};

// 網路狀態管理
const networkManager = {
    init() {
        window.addEventListener('online', this.handleOnline.bind(this));
        window.addEventListener('offline', this.handleOffline.bind(this));
        this.updateConnectionStatus();
    },

    handleOnline() {
        isOnline = true;
        this.updateConnectionStatus();
        elements.offlineBanner.style.display = 'none';
        loadRecords(); // 重新載入資料
        showNotification('🟢 已恢復網路連線', 'success');
    },

    handleOffline() {
        isOnline = false;
        this.updateConnectionStatus();
        elements.offlineBanner.style.display = 'block';
        showNotification('🔴 網路連線中斷', 'error');
    },

    updateConnectionStatus() {
        const status = elements.connectionStatus;
        if (isOnline) {
            status.textContent = '🟢 已連線';
            status.className = 'connection-status status-online';
        } else {
            status.textContent = '🔴 離線';
            status.className = 'connection-status status-offline';
        }
    },

    setConnecting() {
        const status = elements.connectionStatus;
        status.textContent = '🟡 連線中...';
        status.className = 'connection-status status-connecting';
    }
};

// API 呼叫管理
const apiManager = {
    async makeRequest(params, retryCount = 0) {
        if (!isOnline) {
            throw new Error('目前處於離線狀態');
        }

        networkManager.setConnecting();
        
        try {
            const url = `${API_URL}?${new URLSearchParams(params).toString()}&timestamp=${Date.now()}`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超時
            
            const response = await fetch(url, {
                signal: controller.signal,
                cache: 'no-cache'
            });
            
            clearTimeout(timeoutId);
            networkManager.updateConnectionStatus();
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (data.status !== 'success') {
                throw new Error(data.message || '請求失敗');
            }
            
            return data;
            
        } catch (error) {
            networkManager.updateConnectionStatus();
            
            if (error.name === 'AbortError') {
                throw new Error('請求超時，請檢查網路連線');
            }
            
            if (retryCount < CONFIG.RETRY_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY * (retryCount + 1)));
                return this.makeRequest(params, retryCount + 1);
            }
            
            throw error;
        }
    },

    async getAllRecords() {
        const now = Date.now();
        
        // 檢查緩存
        if (callRecords.length > 0 && (now - lastCacheTime) < CONFIG.CACHE_DURATION) {
            return { data: callRecords, fromCache: true };
        }
        
        const result = await this.makeRequest({ action: 'getAll' });
        callRecords = result.data || [];
        lastCacheTime = now;
        
        return { data: callRecords, fromCache: false };
    },

    async addRecord(recordData) {
        const params = {
            action: 'add',
            ...recordData
        };
        
        const result = await this.makeRequest(params);
        
        // 清除緩存以確保資料一致性
        lastCacheTime = 0;
        
        return result;
    },

    async updateStatus(rowIndex, status) {
        const params = {
            action: 'updateStatus',
            rowIndex: rowIndex + 2, // Google Sheets 從第二行開始
            status: status
        };
        
        const result = await this.makeRequest(params);
        
        // 更新本地緩存
        if (callRecords[rowIndex]) {
            callRecords[rowIndex].status = status;
        }
        
        return result;
    },

    async deleteRecord(rowIndex) {
        const params = {
            action: 'delete',
            rowIndex: rowIndex + 2
        };
        
        const result = await this.makeRequest(params);
        
        // 清除緩存
        lastCacheTime = 0;
        
        return result;
    }
};

// 資料管理
const dataManager = {
    filterRecords(searchTerm = '', statusFilter = '') {
        let filtered = [...callRecords];
        
        // 文字搜尋
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            filtered = filtered.filter(record => 
                (record.customerName || '').toLowerCase().includes(term) ||
                (record.customerPhone || '').includes(term) ||
                (record.callerName || '').toLowerCase().includes(term) ||
                (record.extension || '').includes(term) ||
                (record.notes || '').toLowerCase().includes(term)
            );
        }
        
        // 狀態篩選
        if (statusFilter) {
            filtered = filtered.filter(record => record.status === statusFilter);
        }
        
        // 按時間排序（最新的在前）
        filtered.sort((a, b) => new Date(b.callTime || 0) - new Date(a.callTime || 0));
        
        filteredRecords = filtered;
        currentPage = 1;
        
        return filtered;
    },

    getPagedRecords(page = 1) {
        const startIndex = (page - 1) * CONFIG.PAGE_SIZE;
        const endIndex = startIndex + CONFIG.PAGE_SIZE;
        
        return {
            records: filteredRecords.slice(startIndex, endIndex),
            totalPages: Math.ceil(filteredRecords.length / CONFIG.PAGE_SIZE),
            currentPage: page,
            totalRecords: filteredRecords.length
        };
    },

    calculateStats() {
        const total = callRecords.length;
        const pending = callRecords.filter(r => r.status === '待處理').length;
        const resolved = callRecords.filter(r => r.status === '已處理').length;
        const today = callRecords.filter(r => utils.isToday(r.callTime)).length;
        
        return { total, pending, resolved, today };
    }
};

// UI 渲染
const uiManager = {
    renderRecords() {
        const { records, totalPages, currentPage: page, totalRecords } = dataManager.getPagedRecords(currentPage);
        
        if (records.length === 0) {
            elements.recordsList.innerHTML = this.getEmptyState();
            this.updatePaginationInfo(0, 0, 0);
            return;
        }
        
        elements.recordsList.innerHTML = records.map((record, index) => {
            const actualIndex = (currentPage - 1) * CONFIG.PAGE_SIZE + index;
            return this.createRecordHTML(record, actualIndex);
        }).join('');
        
        this.updatePaginationInfo(totalRecords, page, totalPages);
    },

    createRecordHTML(record, index) {
        const statusClass = record.status === '待處理' ? 'status-pending' : 'status-resolved';
        
        return `
            <div class="record-item">
                <div class="record-info">
                    <div class="record-customer">
                        ${record.customerName || ''}
                    </div>
                    <div class="record-details">
                        <span>📱 ${record.customerPhone || ''}</span>
                        <span>👤 ${record.callerName || ''}</span>
                        ${record.extension ? `<span>📞 分機 ${record.extension}</span>` : ''}
                        <span>⏰ ${utils.formatDateTime(record.callTime)}</span>
                    </div>
                    ${record.notes ? `<div style="margin-top: 8px; color: #4a5568; font-size: 0.9em;">💬 ${record.notes}</div>` : ''}
                </div>
                <div class="record-actions">
                    <span class="record-status ${statusClass}">
                        ${record.status || '待處理'}
                    </span>
                    ${this.createActionButtons(record, index)}
                </div>
            </div>
        `;
    },

    createActionButtons(record, index) {
        const isProcessed = record.status === '已處理';
        return `
            <button class="btn btn-small" onclick="toggleStatus(${index})" title="${isProcessed ? '標記為待處理' : '標記為已處理'}">
                ${isProcessed ? '🔄 待處理' : '✅ 已處理'}
            </button>
            <button class="btn btn-danger btn-small" onclick="deleteRecord(${index})" title="刪除記錄">
                🗑️ 刪除
            </button>
        `;
    },

    getEmptyState() {
        const hasFilters = elements.searchBox.value || elements.statusFilter.value;
        
        return `
            <div class="empty-state">
                <div class="icon">${hasFilters ? '🔍' : '📞'}</div>
                <h3>${hasFilters ? '找不到符合條件的紀錄' : '尚無通話紀錄'}</h3>
                <p>${hasFilters ? '請嘗試調整搜尋條件或篩選器' : '開始新增您的第一筆通話紀錄吧！'}</p>
            </div>
        `;
    },

    updateStats() {
        const stats = dataManager.calculateStats();
        
        elements.totalCalls.textContent = stats.total;
        elements.pendingCalls.textContent = stats.pending;
        elements.resolvedCalls.textContent = stats.resolved;
        elements.todayCalls.textContent = stats.today;
    },

    updatePaginationInfo(totalRecords, currentPage, totalPages) {
        if (totalRecords === 0) {
            elements.paginationInfo.textContent = '無資料';
            elements.pageInfo.textContent = '第 0 頁';
            elements.prevBtn.disabled = true;
            elements.nextBtn.disabled = true;
            return;
        }
        
        const start = (currentPage - 1) * CONFIG.PAGE_SIZE + 1;
        const end = Math.min(currentPage * CONFIG.PAGE_SIZE, totalRecords);
        
        elements.paginationInfo.textContent = `顯示 ${start}-${end} 筆，共 ${totalRecords} 筆`;
        elements.pageInfo.textContent = `第 ${currentPage} 頁，共 ${totalPages} 頁`;
        
        elements.prevBtn.disabled = currentPage <= 1;
        elements.nextBtn.disabled = currentPage >= totalPages;
    },

    showLoading() {
        elements.recordsList.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                <p>載入資料中...</p>
            </div>
        `;
    },

    showError(message) {
        elements.recordsList.innerHTML = `
            <div class="error-message">
                ❌ ${message}
                <br><button class="btn btn-small" onclick="loadRecords()" style="margin-top: 10px;">🔄 重試</button>
            </div>
        `;
    }
};

// 通知系統
function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // 觸發動畫
    setTimeout(() => notification.classList.add('show'), 100);
    
    // 自動移除
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (document.body.contains(notification)) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// 主要功能函數
async function loadRecords() {
    if (isLoading) return;
    
    isLoading = true;
    uiManager.showLoading();
    elements.refreshBtn.disabled = true;
    elements.refreshBtn.innerHTML = '⏳ 載入中...';
    
    try {
        const result = await apiManager.getAllRecords();
        
        dataManager.filterRecords(
            elements.searchBox.value,
            elements.statusFilter.value
        );
        
        uiManager.renderRecords();
        uiManager.updateStats();
        
        const message = result.fromCache ? 
            `📊 顯示快取資料 (${callRecords.length} 筆)` :
            `📊 載入完成 (${callRecords.length} 筆紀錄)`;
            
        showNotification(message, 'success');
        
    } catch (error) {
        console.error('載入資料失敗:', error);
        uiManager.showError(error.message);
        showNotification(`❌ 載入失敗: ${error.message}`, 'error');
    } finally {
        isLoading = false;
        elements.refreshBtn.disabled = false;
        elements.refreshBtn.innerHTML = '🔄 重新載入';
    }
}

async function addRecord(formData) {
    elements.submitBtn.disabled = true;
    elements.submitBtn.innerHTML = '⏳ 新增中...';
    
    try {
        await apiManager.addRecord(formData);
        
        elements.callForm.reset();
        setDefaultDateTime();
        
        showNotification('✅ 紀錄已成功新增！', 'success');
        
        // 重新載入資料
        await loadRecords();
        
    } catch (error) {
        console.error('新增紀錄失敗:', error);
        showNotification(`❌ 新增失敗: ${error.message}`, 'error');
    } finally {
        elements.submitBtn.disabled = false;
        elements.submitBtn.innerHTML = '➕ 新增紀錄';
    }
}

async function toggleStatus(index) {
    const actualIndex = (currentPage - 1) * CONFIG.PAGE_SIZE + index;
    const record = filteredRecords[index];
    if (!record) return;
    
    const newStatus = record.status === '待處理' ? '已處理' : '待處理';
    
    try {
        await apiManager.updateStatus(actualIndex, newStatus);
        showNotification(`✅ 已標記為${newStatus}！`, 'success');
        
        // 更新本地資料並重新渲染
        record.status = newStatus;
        uiManager.renderRecords();
        uiManager.updateStats();
        
    } catch (error) {
        console.error('更新狀態失敗:', error);
        showNotification(`❌ 更新失敗: ${error.message}`, 'error');
    }
}

async function deleteRecord(index) {
    if (!confirm('確定要刪除這筆紀錄嗎？此操作無法復原。')) {
        return;
    }
    
    const actualIndex = (currentPage - 1) * CONFIG.PAGE_SIZE + index;
    
    try {
        await apiManager.deleteRecord(actualIndex);
        showNotification('🗑️ 紀錄已刪除！', 'success');
        
        // 重新載入資料
        await loadRecords();
        
    } catch (error) {
        console.error('刪除紀錄失敗:', error);
        showNotification(`❌ 刪除失敗: ${error.message}`, 'error');
    }
}

// 分頁功能
function previousPage() {
    if (currentPage > 1) {
        currentPage--;
        uiManager.renderRecords();
    }
}

function nextPage() {
    const { totalPages } = dataManager.getPagedRecords(currentPage);
    if (currentPage < totalPages) {
        currentPage++;
        uiManager.renderRecords();
    }
}

// 工具函數
function setDefaultDateTime() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById('callTime').value = now.toISOString().slice(0, 16);
}

function clearForm() {
    elements.callForm.reset();
    setDefaultDateTime();
    showNotification('📝 表單已清空', 'info');
}

function exportData() {
    if (callRecords.length === 0) {
        showNotification('❌ 無資料可匯出', 'error');
        return;
    }
    
    try {
        const csvContent = generateCSV(callRecords);
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `通話紀錄_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showNotification('📥 資料已匯出', 'success');
        
    } catch (error) {
        console.error('匯出失敗:', error);
        showNotification('❌ 匯出失敗', 'error');
    }
}

function generateCSV(records) {
    const headers = ['客戶姓名', '客戶電話', '撥打人員', '分機號碼', '撥打時間', '狀態', '備註'];
    const csvRows = [headers.join(',')];
    
    records.forEach(record => {
        const row = [
            `"${record.customerName || ''}"`,
            `"${record.customerPhone || ''}"`,
            `"${record.callerName || ''}"`,
            `"${record.extension || ''}"`,
            `"${utils.formatDateTime(record.callTime)}"`,
            `"${record.status || '待處理'}"`,
            `"${record.notes || ''}"`
        ];
        csvRows.push(row.join(','));
    });
    
    return '\ufeff' + csvRows.join('\n'); // 加入 BOM 以支援中文
}

// 表單驗證
function validateForm(formData) {
    const errors = [];
    
    if (!formData.customerName.trim()) {
        errors.push('客戶姓名為必填欄位');
    }
    
    if (!formData.customerPhone.trim()) {
        errors.push('客戶電話為必填欄位');
    } else if (!utils.validatePhone(formData.customerPhone)) {
        errors.push('請輸入有效的電話號碼');
    }
    
    if (!formData.callerName.trim()) {
        errors.push('撥打人員為必填欄位');
    }
    
    return errors;
}

// 事件監聽器設定
function setupEventListeners() {
    // 表單提交
    elements.callForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const formData = {
            customerName: document.getElementById('customerName').value.trim(),
            customerPhone: document.getElementById('customerPhone').value.trim(),
            callerName: document.getElementById('callerName').value.trim(),
            extension: document.getElementById('extension').value.trim(),
            callTime: document.getElementById('callTime').value,
            notes: document.getElementById('notes').value.trim(),
            status: '待處理'
        };
        
        const errors = validateForm(formData);
        if (errors.length > 0) {
            showNotification(`❌ ${errors[0]}`, 'error');
            return;
        }
        
        await addRecord(formData);
    });
    
    // 搜尋和篩選 - 使用防抖
    const debouncedFilter = utils.debounce(() => {
        dataManager.filterRecords(
            elements.searchBox.value,
            elements.statusFilter.value
        );
        uiManager.renderRecords();
    }, CONFIG.DEBOUNCE_DELAY);
    
    elements.searchBox.addEventListener('input', debouncedFilter);
    elements.statusFilter.addEventListener('change', debouncedFilter);
    
    // 鍵盤快捷鍵
    document.addEventListener('keydown', function(e) {
        // Ctrl+R 重新載入
        if (e.ctrlKey && e.key === 'r') {
            e.preventDefault();
            loadRecords();
        }
        
        // Ctrl+N 聚焦到客戶姓名欄位
        if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            document.getElementById('customerName').focus();
        }
        
        // ESC 清空搜尋
        if (e.key === 'Escape') {
            elements.searchBox.value = '';
            elements.statusFilter.value = '';
            debouncedFilter();
        }
    });
}

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 電話紀錄管理系統初始化中...');
    
    // 設定預設時間
    setDefaultDateTime();
    
    // 初始化網路狀態管理
    networkManager.init();
    
    // 設定事件監聽器
    setupEventListeners();
    
    // 載入初始資料
    loadRecords();
    
    console.log('✅ 系統初始化完成');
});

// 定期重新載入資料（每5分鐘）
setInterval(() => {
    if (isOnline && !isLoading) {
        console.log('🔄 定期重新載入資料...');
        loadRecords();
    }
}, 300000);