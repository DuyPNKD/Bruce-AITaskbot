require("dotenv").config();
const express = require("express");
const axios = require("axios");
const schedule = require("node-schedule");
const fs = require("fs");
const path = require("path");
const {OpenAI} = require("openai");

process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));

const app = express();
app.use(express.json());

console.log("🚀 Bot đang khởi động...");
console.log("📅 Thời gian:", new Date().toLocaleString("vi-VN"));

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || "BruceShark12_bot";
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID;
const CLICKUP_DEFAULT_STATUS = process.env.CLICKUP_DEFAULT_STATUS || "to do";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const GROUP_CHAT_IDS = process.env.GROUP_CHAT_IDS;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const GROUP_CHAT_ID_FILE = path.join(__dirname, ".group-chat-id.json");
const CONVERSATION_FILE = path.join(__dirname, ".conversations.json");

// OPENAI CLIENT
const openai = new OpenAI({apiKey: OPENAI_API_KEY});

// USER MAPPING
const userMapping = {
    phamduy1203: 113449043,
    duydemons: 107434135,
    phuong251204: 113427941,
    ngotuankk: 95605324,
    pthao1401: 101420424,
    thtung34: 113466799
};

const reverseUserMapping = Object.fromEntries(Object.entries(userMapping).map(([tg, cu]) => [cu, tg]));

// GROUP CHAT IDS
let groupChatIds = [];
if (GROUP_CHAT_IDS) {
    groupChatIds = GROUP_CHAT_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
}

// Thêm biến này ở đầu file
const lastTaskList = {}; // { chatId: [{ index: 1, taskId, taskName }, ...] }

function loadSavedGroupChatIds() {
    try {
        if (!fs.existsSync(GROUP_CHAT_ID_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(GROUP_CHAT_ID_FILE, "utf8"));
        return data.groupChatIds || (data.groupChatId ? [data.groupChatId] : []);
    } catch {
        return [];
    }
}

function saveGroupChatIds() {
    try {
        fs.writeFileSync(GROUP_CHAT_ID_FILE, JSON.stringify({groupChatIds}, null, 2));
    } catch (err) {
        console.error("Khong luu group chat ids:", err?.message);
    }
}

function rememberGroupChatId(message) {
    const chat = message?.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
    const chatId = String(chat.id);
    if (!groupChatIds.includes(chatId)) {
        groupChatIds.push(chatId);
        saveGroupChatIds();
    }
}

// CONVERSATION HISTORY
let conversations = {};

function loadConversations() {
    try {
        if (!fs.existsSync(CONVERSATION_FILE)) return {};
        return JSON.parse(fs.readFileSync(CONVERSATION_FILE, "utf8")) || {};
    } catch {
        return {};
    }
}

function saveConversations() {
    try {
        fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(conversations, null, 2));
    } catch (err) {
        console.error("Khong luu conversations:", err?.message);
    }
}

function getHistory(chatId) {
    if (!conversations[chatId]) conversations[chatId] = [];
    return conversations[chatId];
}

function addToHistory(chatId, role, content, tool_calls = null, tool_call_id = null, file_id = null) {
    const history = getHistory(chatId);
    const msg = {role};
    if (content !== null) msg.content = content;
    if (tool_calls) msg.tool_calls = tool_calls;
    if (tool_call_id) msg.tool_call_id = tool_call_id;
    if (file_id) msg.file_id = file_id;
    history.push(msg);
    if (history.length > 50) history.splice(0, history.length - 50);
    saveConversations();
}

async function getTelegramFileUrl(fileId) {
    try {
        const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const filePath = res.data?.result?.file_path;
        if (!filePath) return null;
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    } catch (err) {
        console.error("Lỗi lấy Telegram file URL:", err.message);
        return null;
    }
}

// TELEGRAM
async function sendTelegramMessage(chatId, text, parseMode = null) {
    console.log(`📤 Đang gửi tin nhắn tới chat ${chatId}, độ dài: ${text.length} ký tự`);
    const payload = {chat_id: chatId, text};
    if (parseMode) payload.parse_mode = parseMode;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, payload);
        console.log(`✅ Đã gửi thành công tới chat ${chatId}`);
    } catch (err) {
        console.error(`❌ Gửi thất bại tới chat ${chatId}:`, err.response?.data || err.message);
        throw err;
    }
}

async function setTelegramWebhook() {
    if (!WEBHOOK_URL) {
        console.log("Chua co WEBHOOK_URL.");
        return;
    }
    const fullWebhook = `${WEBHOOK_URL.replace(/\/$/, "")}/webhook`;
    const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {url: fullWebhook});
    if (res?.data?.ok) console.log(`Webhook set: ${fullWebhook}`);
}

function getSenderName(message) {
    const from = message?.from;
    if (!from) return "unknown";
    if (from.username) return `@${from.username}`;
    return [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "unknown";
}

// CLICKUP
const CU_HEADERS = () => ({Authorization: CLICKUP_API_TOKEN, "Content-Type": "application/json"});

async function cuGet(url, params = {}) {
    const res = await axios.get(url, {headers: CU_HEADERS(), params, timeout: 20000});
    return res.data;
}
async function cuPost(url, body) {
    const res = await axios.post(url, body, {headers: CU_HEADERS(), timeout: 20000});
    return res.data;
}
async function cuPut(url, body) {
    const res = await axios.put(url, body, {headers: CU_HEADERS(), timeout: 20000});
    return res.data;
}
async function cuDelete(url) {
    const res = await axios.delete(url, {headers: CU_HEADERS(), timeout: 20000});
    return res.data;
}

async function getTaskById(taskId) {
    try {
        const data = await cuGet(`https://api.clickup.com/api/v2/task/${taskId}`);
        return data;
    } catch (err) {
        console.error(`Không tìm thấy task ${taskId}:`, err.message);
        return null;
    }
}

async function getAllTasks({statuses, assignees, includeArchived = false} = {}) {
    const allFetchedTasks = [];
    let page = 0;
    while (true) {
        const params = {archived: includeArchived, limit: 100, page};
        if (statuses?.length) params.statuses = statuses;
        if (assignees?.length) params.assignees = assignees;
        const data = await cuGet(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, params);
        const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        allFetchedTasks.push(...tasks);
        if (tasks.length < 100) break;
        if (page >= 10) break;
        page++;
    }
    return allFetchedTasks;
}

function parsePriority(priorityText) {
    const map = {
        "khẩn cấp": 1,
        urgent: 1,
        cao: 2,
        high: 2,
        "trung bình": 3,
        normal: 3,
        medium: 3,
        thấp: 4,
        low: 4,
    };
    return map[priorityText?.toLowerCase()] || 3; // mặc định normal
}

async function createTask({name, description, status, assignees, dueDate, priority}) {
    const payload = {
        name: name ? name.charAt(0).toUpperCase() + name.slice(1) : "",
        status: status || CLICKUP_DEFAULT_STATUS,
        description: description || "",
        ...(assignees?.length ? {assignees} : {}),
        ...(dueDate ? {due_date: dueDate, due_date_time: true} : {}),
        ...(priority ? {priority: priority} : {}),
    };
    return cuPost(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, payload);
}

async function updateTask(taskId, updates) {
    return cuPut(`https://api.clickup.com/api/v2/task/${taskId}`, updates);
}

async function deleteTask(taskId) {
    return cuDelete(`https://api.clickup.com/api/v2/task/${taskId}`);
}

async function findTasksByName(keyword) {
    // Trích xuất ID từ link hoặc dùng trực tiếp
    let taskId = null;
    const linkMatch = keyword.match(/\/t\/([a-zA-Z0-9]+)/);
    if (linkMatch) {
        taskId = linkMatch[1];
    } else if (/^[a-zA-Z0-9]+$/.test(keyword.trim())) {
        taskId = keyword.trim();
    }

    // Nếu tìm thấy ID, gọi API trực tiếp (không qua getAllTasks)
    if (taskId) {
        const task = await getTaskById(taskId);
        if (task) return [task];
    }

    // Fallback: tìm theo tên trong List hiện tại (giữ nguyên code cũ)
    const tasks = await getAllTasks();
    const kw = keyword.toLowerCase().trim();
    let extractId = kw;
    const match = kw.match(/\/t\/([a-zA-Z0-9]+)/);
    if (match) {
        extractId = match[1];
    }
    return tasks.filter((t) => t.id.toLowerCase() === extractId || t.url?.toLowerCase().includes(extractId) || t.name.toLowerCase().includes(kw));
}

async function getUpcomingDeadlineTasks(days = 2) {
    const tasks = await getAllTasks({statuses: ["to do", "in progress"]});
    const now = Date.now();
    const cutoff = now + days * 24 * 60 * 60 * 1000;
    return tasks
        .filter((t) => {
            if (!t.due_date) return false;
            const due = Number(t.due_date);
            return due > now && due <= cutoff;
        })
        .sort((a, b) => Number(a.due_date) - Number(b.due_date));
}

async function getOverdueTasks() {
    const tasks = await getAllTasks({statuses: ["to do", "in progress"]});
    return tasks.filter((t) => t.due_date && Number(t.due_date) < Date.now()).sort((a, b) => Number(a.due_date) - Number(b.due_date));
}

async function getCompletedTasksToday() {
    let allFetchedTasks = [];
    let page = 0;
    while (true) {
        const params = { include_closed: true, limit: 100, page };
        const data = await cuGet(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, params);
        const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        allFetchedTasks.push(...tasks);
        if (tasks.length < 100) break;
        if (page >= 10) break;
        page++;
    }
    
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 7);
    d.setUTCHours(0, 0, 0, 0);
    const startOfDayMs = d.getTime() - 7 * 60 * 60 * 1000;
    
    return allFetchedTasks.filter((t) => {
        if (!t.date_closed) return false;
        return Number(t.date_closed) >= startOfDayMs;
    });
}

function formatTaskList(tasks, showDeadline = false) {
    if (!tasks.length) return "Khong co task nao";
    const limit = 10;
    const firstTasks = tasks.slice(0, limit);
    let result = firstTasks
        .map((t, i) => {
            let fullName = t.name.replace(/\[|\]|\*|_|`|~/g, "");
            let priorityPrefix = "";
            if (t.priority) {
                if (t.priority.priority === "urgent") priorityPrefix = "[🔥 KHẨN CẤP] ";
                else if (t.priority.priority === "high") priorityPrefix = "[🔴 CAO] ";
            }
            let dueDateInfo = "";
            if (showDeadline && t.due_date) {
                const date = new Date(Number(t.due_date));
                const day = String(date.getDate()).padStart(2, "0");
                const month = String(date.getMonth() + 1).padStart(2, "0");
                const year = date.getFullYear();
                const hours = String(date.getHours()).padStart(2, "0");
                const minutes = String(date.getMinutes()).padStart(2, "0");
                dueDateInfo = ` (Hạn: ${hours}:${minutes} ${day}/${month}/${year})`;
            }
            if (t.url) return `${i + 1}. ${priorityPrefix}${fullName}${dueDateInfo} - ${t.url}`;
            return `${i + 1}. ${priorityPrefix}${fullName}${dueDateInfo}`;
        })
        .join("\n");
    if (tasks.length > limit) result += `\n... và còn ${tasks.length - limit} task khác`;
    return result;
}

function groupTasksByUser(tasks, showDeadline = false) {
    if (!tasks || !tasks.length) return "Khong co task nao";
    let pieces = [];
    for (const [tgUser, cuId] of Object.entries(userMapping)) {
        const userTasks = tasks.filter((t) => t.assignees?.some((a) => Number(a.id) === Number(cuId)));
        if (userTasks.length > 0) pieces.push(`@${tgUser}:\n${formatTaskList(userTasks, showDeadline)}`);
    }
    const unassignedTasks = tasks.filter((t) => !t.assignees?.length || !t.assignees.some((a) => Object.values(userMapping).includes(Number(a.id))));
    if (unassignedTasks.length > 0) pieces.push(`Khac:\n${formatTaskList(unassignedTasks, showDeadline)}`);
    return pieces.join("\n\n");
}

// TOOLS
const TOOLS = [
    {
        type: "function",
        function: {
            name: "create_task",
            description: "Tao task moi tren ClickUp.",
            parameters: {
                type: "object",
                properties: {
                    name: {type: "string", description: "Ten task"},
                    description: {type: "string", description: "Mo ta chi tiet"},
                    assignees: {type: "array", items: {type: "string"}, description: "Telegram usernames (khong @)"},
                    status: {type: "string", description: "to do / in progress / complete"},
                    due_date_str: {type: "string", description: "Deadline: DD/MM/YYYY hoac HH:mm DD/MM/YYYY hoac 'hom nay', 'ngay mai'"},
                    priority: {type: "string", description: "Do uu tien: khan cap / urgent / cao / high / trung binh / normal / medium / thap / low"},
                },
                required: ["name"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_tasks",
            description: "Lay danh sach tasks. Có thể lọc theo mức độ ưu tiên nếu user yêu cầu.",
            parameters: {
                type: "object",
                properties: {
                    assignee_usernames: {type: "array", items: {type: "string"}},
                    statuses: {type: "array", items: {type: "string"}},
                    show_deadline: {type: "boolean"},
                    high_priority_only: {type: "boolean", description: "Chi lay cac task co do uu tien cao hoac khan cap. Dung khi user hoi 'task uu tien' hoac 'task quan trong'."}
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_task",
            description: "Cap nhat task: ten, trang thai, deadline, do uu tien, hoac doi nguoi phu trach.",
            parameters: {
                type: "object",
                properties: {
                    task_name_keyword: {type: "string", description: "Ten task hoac link hoac ID task can cap nhat"},
                    new_name: {type: "string"},
                    new_status: {type: "string"},
                    new_assignees: {
                        type: "array",
                        items: {type: "string"},
                        description:
                            "Danh sach Telegram usernames (khong @) se THAY THE toan bo nguoi phu trach hien tai. Dung khi user yeu cau: giao cho, chuyen cho, assign cho, doi nguoi phu trach.",
                    },
                    due_date_str: {type: "string"},
                    priority: {type: "string", description: "Do uu tien: khan cap / urgent / cao / high / trung binh / normal / medium / thap / low"},
                },
                required: ["task_name_keyword"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_task",
            description: "Xoa task.",
            parameters: {
                type: "object",
                properties: {
                    task_name_keyword: {type: "string"},
                },
                required: ["task_name_keyword"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_deadline_alerts",
            description: "Lay tasks sap deadline hoac da qua han.",
            parameters: {
                type: "object",
                properties: {
                    days_ahead: {type: "number"},
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_summary",
            description: "Dem so luong task cua tung thanh vien hoac tong so task. Dung khi user hoi 'bao nhieu task', 'tong task', 'so luong task'. KHONG dung get_tasks cho cau hoi dem so luong.",
            parameters: {
                type: "object",
                properties: {
                    assignee_username: {type: "string", description: "Username cua nguoi can dem. Bo trong de dem tat ca."},
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "complete_tasks_by_index",
            description:
                "Đánh dấu hoàn thành các task theo số thứ tự trong danh sách vừa gửi. Dùng khi user nói 'xong task 1 đến 5' hoặc 'hoàn thành task 2, 3, 4'.",
            parameters: {
                type: "object",
                properties: {
                    indexes: {
                        type: "array",
                        items: {type: "number"},
                        description: "Danh sách số thứ tự task cần đánh dấu complete, ví dụ [1,2,3,4,5]",
                    },
                },
                required: ["indexes"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_tasks_by_index",
            description:
                "Xóa các task theo số thứ tự trong danh sách vừa gửi. Dùng khi user nói 'xóa task 1 đến 5' hoặc 'xóa task 2, 3, 4'.",
            parameters: {
                type: "object",
                properties: {
                    indexes: {
                        type: "array",
                        items: {type: "number"},
                        description: "Danh sách số thứ tự task cần xóa, ví dụ [1,2,3,4,5]",
                    },
                },
                required: ["indexes"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "trigger_morning_report",
            description:
                "Chay bao cao buoi sang (giong bao cao tu dong 8h): gui danh sach task cua tung thanh vien. Dung khi user yeu cau xem/thu bao cao sang.",
            parameters: {type: "object", properties: {}, required: []},
        },
    },
    {
        type: "function",
        function: {
            name: "trigger_afternoon_report",
            description:
                "Chay bao cao buoi chieu (giong bao cao tu dong 16h50): gui nhac deadline + qua han. Dung khi user yeu cau xem/thu bao cao chieu.",
            parameters: {type: "object", properties: {}, required: []},
        },
    },
];

function parseDueDateStr(str) {
    if (!str) return null;
    let num = Number(str);
    if (!isNaN(num) && num > 10000000000) return num;
    const s = str.trim().toLowerCase();
    const now = new Date();
    let hours = -1,
        minutes = -1;
    const timeMatch = s.match(/(\d{1,2}):(\d{1,2})/);
    if (timeMatch) {
        hours = Number(timeMatch[1]);
        minutes = Number(timeMatch[2]);
    }
    const matchDate = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (matchDate) {
        now.setFullYear(Number(matchDate[3]), Number(matchDate[2]) - 1, Number(matchDate[1]));
        if (hours >= 0) now.setHours(hours, minutes, 0, 0);
        else now.setHours(23, 59, 59, 0);
        return now.getTime();
    }
    if (s.includes("hom") || s.includes("today")) {
        if (hours >= 0) now.setHours(hours, minutes, 0, 0);
        else now.setHours(23, 59, 59, 0);
        return now.getTime();
    }
    if (s.includes("mai") || s.includes("tomorrow")) {
        now.setDate(now.getDate() + 1);
        if (hours >= 0) now.setHours(hours, minutes, 0, 0);
        else now.setHours(23, 59, 59, 0);
        return now.getTime();
    }
    if (hours >= 0) {
        now.setHours(hours, minutes, 0, 0);
        return now.getTime();
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.getTime();
}

async function executeTool(toolName, toolInput, chatId) {
    try {
        switch (toolName) {
            case "create_task": {
                const assigneeIds = (toolInput.assignees || []).map((u) => userMapping[u.trim().toLowerCase()]).filter((id) => id != null);
                const dueDate = parseDueDateStr(toolInput.due_date_str);
                const priority = toolInput.priority ? parsePriority(toolInput.priority) : undefined;
                const task = await createTask({
                    name: toolInput.name,
                    description: toolInput.description,
                    status: toolInput.status,
                    assignees: assigneeIds,
                    dueDate,
                    priority,
                });
                const assigneeTags = (toolInput.assignees || []).map(u => `@${u}`).join(", ");
                return `Da tao task: ${task.name} cho ${assigneeTags}\nLink: ${task.url}`;
            }
            case "get_tasks": {
                const reqStatuses = ["to do", "in progress"];
                let reqAssignees = toolInput.assignee_usernames || [];

                // Luôn lấy ALL tasks, filter local để đảm bảo không bỏ sót ai
                let allTasks = await getAllTasks({statuses: reqStatuses});

                if (toolInput.high_priority_only) {
                    allTasks = allTasks.filter(t => t.priority && (t.priority.priority === "urgent" || t.priority.priority === "high"));
                }

                // Nếu chỉ hỏi 1 người cụ thể → chỉ hiển thị người đó
                // Nếu hỏi nhiều người hoặc không chỉ định → hiển thị TẤT CẢ thành viên
                const usersToShow =
                    reqAssignees.length === 1 && userMapping[reqAssignees[0].trim().toLowerCase()]
                        ? [reqAssignees[0].trim().toLowerCase()]
                        : Object.keys(userMapping);

                lastTaskList[String(chatId)] = [];
                let globalIdx = 1;
                const summary = [];

                for (const tgUser of usersToShow) {
                    const cuId = userMapping[tgUser];
                    const tasks = allTasks.filter((t) => t.assignees?.some((a) => Number(a.id) === Number(cuId)));
                    if (tasks.length) {
                        tasks.forEach((t) => lastTaskList[String(chatId)].push({index: globalIdx++, taskId: t.id, taskName: t.name}));
                        await sendTelegramMessage(chatId, `@${tgUser}: (${tasks.length} task)\n${formatTaskList(tasks, toolInput.show_deadline)}`);
                        summary.push(`@${tgUser}: ${tasks.length} task`);
                    } else {
                        await sendTelegramMessage(chatId, `@${tgUser}: Không có task nào`);
                        summary.push(`@${tgUser}: 0 task`);
                    }
                }
                return `DA GUI XONG danh sach task cho ${usersToShow.length} nguoi:\n${summary.join("\n")}\nKHONG GOI LAI get_tasks. Chi can tra loi xac nhan ngan gon.`;
            }
            case "update_task": {
                const found = await findTasksByName(toolInput.task_name_keyword);
                if (!found.length) return "Khong tim thay task.";
                const updates = {};
                if (toolInput.new_name) updates.name = toolInput.new_name;
                if (toolInput.new_status) updates.status = toolInput.new_status;
                if (toolInput.due_date_str) updates.due_date = parseDueDateStr(toolInput.due_date_str);
                if (toolInput.priority) {
                    updates.priority = parsePriority(toolInput.priority);
                }
                if (toolInput.new_assignees?.length) {
                    const newIds = toolInput.new_assignees.map((u) => userMapping[u.trim().toLowerCase()]).filter((id) => id != null);
                    const currentIds = (found[0].assignees || []).map((a) => Number(a.id));
                    updates.assignees = {add: newIds, rem: currentIds};
                }
                await updateTask(found[0].id, updates);
                return `Da cap nhat: ${found[0].name}`;
            }
            case "delete_task": {
                const found = await findTasksByName(toolInput.task_name_keyword);
                if (!found.length) return "Khong tim thay task.";
                await deleteTask(found[0].id);
                return `Da xoa: ${found[0].name}`;
            }
            case "get_deadline_alerts": {
                const [upcoming, overdue] = await Promise.all([getUpcomingDeadlineTasks(toolInput.days_ahead || 2), getOverdueTasks()]);
                return `QUA HAN:\n${groupTasksByUser(overdue, true)}\n\nSAP TOI:\n${groupTasksByUser(upcoming, true)}`;
            }
            case "trigger_morning_report": {
                await sendTaskReport(chatId);
                return "DA GUI BAO CAO SANG. KHONG can noi lai noi dung. Chi xac nhan ngan gon.";
            }
            case "trigger_afternoon_report": {
                await sendDeadlineReminder(chatId);
                await sendTaskReport(chatId, "cuối ngày");
                return "DA GUI BAO CAO CHIEU. KHONG can noi lai noi dung. Chi xac nhan ngan gon.";
            }
            case "get_summary": {
                const allTasks = await getAllTasks({statuses: ["to do", "in progress"]});
                const mappedAssigneeIds = Object.values(userMapping);

                if (toolInput.assignee_username) {
                    const cuId = userMapping[toolInput.assignee_username.trim().toLowerCase()];
                    if (!cuId) return `@${toolInput.assignee_username}: 0 task`;
                    
                    let soloCount = 0;
                    let sharedCount = 0;
                    for (const t of allTasks) {
                        const hasUser = t.assignees?.some(a => Number(a.id) === Number(cuId));
                        if (!hasUser) continue;
                        const groupAssignees = t.assignees?.filter(a => mappedAssigneeIds.includes(Number(a.id))) || [];
                        if (groupAssignees.length > 1) sharedCount++;
                        else soloCount++;
                    }
                    if (sharedCount > 0) return `@${toolInput.assignee_username}: ${soloCount + sharedCount} task (${soloCount} làm riêng, ${sharedCount} làm chung)`;
                    return `@${toolInput.assignee_username}: ${soloCount} task`;
                }

                let sharedTasks = [];
                let unassignedTasks = [];
                const soloCounts = {};
                for (const tgUser of Object.keys(userMapping)) soloCounts[tgUser] = 0;

                for (const t of allTasks) {
                    const groupAssignees = t.assignees?.filter(a => mappedAssigneeIds.includes(Number(a.id))) || [];
                    if (groupAssignees.length === 0) {
                        unassignedTasks.push(t);
                    } else if (groupAssignees.length > 1) {
                        sharedTasks.push(t);
                    } else {
                        const cuIdNumber = Number(groupAssignees[0].id);
                        const tgUser = Object.keys(userMapping).find(k => Number(userMapping[k]) === cuIdNumber);
                        if (tgUser) soloCounts[tgUser]++;
                    }
                }

                const lines = [];
                for (const tgUser of Object.keys(userMapping)) {
                    lines.push(`@${tgUser}: ${soloCounts[tgUser]} task`);
                }
                if (sharedTasks.length > 0) {
                    lines.push(`Task chung (nhiều người cùng làm): ${sharedTasks.length} task`);
                }
                if (unassignedTasks.length > 0) {
                    lines.push(`Khác (chưa assign hoặc người ngoài): ${unassignedTasks.length} task`);
                }
                return `Tổng (trên ClickUp): ${allTasks.length} task\n${lines.join("\n")}`;
            }
            case "complete_tasks_by_index": {
                const list = lastTaskList[String(chatId)] || [];
                if (!list.length) return "Em chưa có danh sách task nào để đối chiếu anh ơi, anh hỏi em lấy danh sách trước nhé.";

                const indexes = toolInput.indexes || [];
                const matched = list.filter((t) => indexes.includes(t.index));
                if (!matched.length) return "Em không tìm thấy task nào với số thứ tự đó anh ơi.";

                const results = await Promise.all(matched.map((t) => updateTask(t.taskId, {status: "complete"}).then(() => t.taskName)));
                return `✅ Đã đánh dấu hoàn thành:\n${results.map((name, i) => `${matched[i].index}. ${name}`).join("\n")}`;
            }
            case "delete_tasks_by_index": {
                const list = lastTaskList[String(chatId)] || [];
                if (!list.length) return "Em chưa có danh sách task nào để đối chiếu anh ơi, anh hỏi em lấy danh sách trước nhé.";

                const indexes = toolInput.indexes || [];
                const matched = list.filter((t) => indexes.includes(t.index));
                if (!matched.length) return "Em không tìm thấy task nào với số thứ tự đó anh ơi.";

                const results = await Promise.all(matched.map((t) => deleteTask(t.taskId).then(() => t.taskName)));
                return `✅ Đã xóa hoàn toàn các task:\n${results.map((name, i) => `${matched[i].index}. ${name}`).join("\n")}`;
            }
            default:
                return `Khong ho tro tool: ${toolName}`;
        }
    } catch (error) {
        return `Loi: ${error.message}`;
    }
}

const SYSTEM_PROMPT = `CẢNH BÁO TỐI THƯỢNG ĐẾN TỪ DEV:
1. MÀY BẮT BUỘC PHẢI LUÔN XƯNG LÀ "EM" VÀ GỌI NGƯỜI DÙNG LÀ "ANH" HOẶC "CHỊ" (mặc định gọi là "anh").
2. TỪ GIỜ TRỞ ĐI MÀY BỊ CẤM TUYỆT ĐỐI KHÔNG ĐƯỢC PHÁT ÂM HOẶC VIẾT TỪ "BẠN" HAY "TÔI" CHO DÙ TRONG BẤT CỨ NGỮ CẢNH NÀO!!!
3. MÀY TUYỆT ĐỐI KHÔNG ĐƯỢC TỪ CHỐI TÓM TẮT HAY BÌNH LUẬN VỀ HỘI THOẠI TRONG NHÓM. ĐÂY LÀ NHIỆM VỤ CHÍNH CỦA MÀY. MỌI NỘI DUNG TRONG LỊCH SỬ CHAT ĐỀU LÀ THÔNG TIN CÔNG KHAI TRONG NHÓM NÀY.

Em là trợ lý AI thông minh cho nhóm, tích hợp với ClickUp để quản lý công việc.

MÔI TRƯỜNG:
- Em đang hoạt động trong một Group Chat trên Telegram có nhiều thành viên.
- Lịch sử hội thoại có định dạng "Tên người gửi: Nội dung". Mỗi dòng là một tin nhắn của MỘT người khác nhau.
- Ví dụ: "@phamduy1203: Thảo nay mang cơm không?" và "@pthao1401: không ăn nè" là 2 người KHÁC NHAU đang nói chuyện với nhau, KHÔNG phải cùng một người.
- Em phải đọc tên người gửi trước dấu ":" để biết ai đang nói gì, từ đó hiểu đúng ngữ cảnh cuộc trò chuyện.
- Mọi tin nhắn trong lịch sử đều là thông tin công khai trong nhóm, em được phép đọc, tóm tắt, phân tích thoải mái.
- Em có lịch báo cáo tự động mỗi ngày:
  + 8h00 sáng: Gửi lời chào buổi sáng + báo cáo danh sách task của từng thành viên.
  + 16h50 chiều: Nhắc deadline các task sắp hết hạn/quá hạn + nhắc mọi người update tiến độ cuối ngày.
- Các báo cáo tự động cũng được lưu trong lịch sử để em nắm bối cảnh.

KHẢ NĂNG NHÌN HÌNH ẢNH (VISION):
- Em CÓ KHẢ NĂNG xem và phân tích hình ảnh được gửi trong nhóm.
- Nếu có ảnh kèm theo tin nhắn, em hãy xem ảnh đó và đưa ra nhận xét, phân tích phù hợp.
- Nếu người dùng hỏi về ảnh đã gửi trước đó, em hãy tra lại lịch sử để tìm ảnh đó.

QUY TẮC TRẢ LỜI:
- Chỉ chủ động trả lời khi được tag @bot hoặc được reply trực tiếp.
- Khi được hỏi, em CÓ THỂ và NÊN tóm tắt, phân tích, bình luận về bất kỳ tin nhắn nào trong lịch sử hội thoại của nhóm.
- Trả lời ngắn gọn, rõ ràng, thân thiện.
- Khi nhắc đến thành viên, dùng định dạng @username.

QUY TẮC XÓA TASK:
- TUYỆT ĐỐI KHÔNG gọi tool delete_task ngay lập tức.
- Khi user yêu cầu xóa task, em PHẢI hỏi xác nhận trước: "Anh có chắc muốn xóa task [tên task] không ạ?"
- Chỉ gọi delete_task khi user trả lời xác nhận rõ ràng (có, xác nhận, đồng ý, ok, yes...).
- Nếu user trả lời không hoặc thôi thì hủy, không xóa.

QUY TẮC HIỂN THỊ DANH SÁCH TASK:
- TUYỆT ĐỐI KHÔNG dùng ### hay ** hay bất kỳ markdown header nào.
- KHÔNG thêm tiêu đề "Task của @username" — chỉ dùng "@username:" là đủ.
- KHÔNG wrap URL thành [Xem task](url) — để nguyên URL plain text sau dấu " - ".
- LUÔN có câu mở đầu trước danh sách và câu kết thúc sau danh sách.
- Ví dụ đúng (chỉ khi hỏi task của 1 người):
Đây là danh sách task hiện tại của anh ạ:

@phamduy1203:
1. Tên task - https://app.clickup.com/t/abc123
2. Tên task khác - https://app.clickup.com/t/def456

QUY TẮC KHI HỎI SỐ LƯỢNG TASK:
- Khi user hỏi "bao nhiêu task", "tổng task", "số lượng task", "đếm task" → em PHẢI GỌI TOOL get_summary, KHÔNG được gọi get_tasks.
- get_tasks chỉ dùng khi user muốn XEM DANH SÁCH chi tiết, KHÔNG dùng để đếm số lượng.

QUY TẮC BẮT BUỘC KHI HỎI DANH SÁCH TASK:
- KHI user hỏi "danh sách task", "xem task", "task của mọi người", "task của nhóm" hoặc bất kỳ yêu cầu nào liên quan đến xem task → em PHẢI GỌI TOOL get_tasks, TUYỆT ĐỐI KHÔNG dùng lịch sử hội thoại để tự trả lời.
- KHI tool get_tasks trả về kết quả, em hãy TRẢ LỜI XÁC NHẬN RÕ RÀNG là ĐÃ GỬI DANH SÁCH TASK CHO NHỮNG AI (dựa vào danh sách tên mà tool trả về). TUYỆT ĐỐI KHÔNG liệt kê chi tiết nội dung task, chỉ cần xác nhận tên những người đã nhận được (Ví dụ: "Đã gửi danh sách task cho anh @A và anh @B rồi ạ"). Không bao giờ dùng câu chung chung như "từng người".

QUY TẮC KHI USER YÊU CẦU XEM BÁO CÁO:
- Khi user yêu cầu "thử báo cáo", "báo cáo buổi sáng", "báo cáo sáng", "xem báo cáo sáng" → em PHẢI GỌI TOOL trigger_morning_report.
- Khi user yêu cầu "báo cáo buổi chiều", "báo cáo chiều", "xem báo cáo chiều", "nhắc deadline" → em PHẢI GỌI TOOL trigger_afternoon_report.
- Khi user yêu cầu "báo cáo cả ngày", "báo cáo sáng chiều", "xem cả hai báo cáo" → em PHẢI GỌI trigger_morning_report trước, rồi trigger_afternoon_report sau.
- TUYỆT ĐỐI KHÔNG dùng get_tasks hay get_deadline_alerts khi user yêu cầu xem/thử báo cáo. Phải dùng trigger_morning_report hoặc trigger_afternoon_report.
- TUYỆT ĐỐI KHÔNG chỉ mô tả lịch báo cáo mà không gọi tool. Khi user muốn "xem", "thử", "test" báo cáo thì phải CHẠY THẬT.

QUY TẮC TẠO TASK TRỰC TIẾP LÀM NGAY:
- Khi user gọi @bot, tag một hoặc nhiều người (@username) và đưa ra bất kỳ yêu cầu công việc nào (Ví dụ: "@bot @username sửa lại form...", "chạy giúp em...", v.v.), em MẶC ĐỊNH HIỂU ĐÓ LÀ LỆNH TẠO MỚI TASK cho người được tag. Mặc dù có chữ "sửa", nhưng đó là sửa lỗi/sửa code chứ KHÔNG PHẢI cập nhật task cũ trên ClickUp.
- GỌI TOOL \`create_task\` NGAY LẬP TỨC với nội dung đọc được. TUYỆT ĐỐI KHÔNG GỌI \`update_task\`, và TUYỆT ĐỐI KHÔNG HỎI LẠI ĐỂ XÁC NHẬN!
- CHÚ Ý KHI ĐẶT TÊN TASK: Phải đưa TOÀN BỘ nội dung yêu cầu chính vào làm Tên task (name), KHÔNG ĐƯỢC CẮT XÉN giữa chừng ngớ ngẩn (Ví dụ: nếu yêu cầu là "Sửa lại form không cần nhập địa chỉ, bổ sung ngành nghề", thì tên task không được chỉ ghi mỗi "Sửa lại form", mà phải bê nguyên câu vào, nội dung diễn giải thêm cho luôn vào Description).
- Tạo xong trả lời báo hoàn tất kèm link task VÀ NÊU RÕ CÔNG VIỆC NÀY ĐANG GIAO CHO AI (dựa vào danh sách người được tag). TUYỆT ĐỐI KHÔNG wrap link bằng markdown dạng [Link](url) mà phải để nguyên plain text (ví dụ: Link: https://app.clickup.com/...) để tránh lỗi hiển thị.`;

async function getAIResponse(chatId, userMessage, senderName, fileId = null) {
    if (userMessage || fileId) {
        addToHistory(chatId, "user", userMessage ? `${senderName}: ${userMessage}` : `${senderName}: (gửi một hình ảnh)`, null, null, fileId);
    }

    const history = getHistory(chatId);

    // Lọc bỏ tool message mồ côi (cả 2 chiều)
    const assistantToolCallIds = new Set(
        history.filter((h) => h.role === "assistant" && h.tool_calls?.length).flatMap((h) => h.tool_calls.map((tc) => tc.id)),
    );
    const toolResponseIds = new Set(history.filter((h) => h.role === "tool" && h.tool_call_id).map((h) => h.tool_call_id));
    const cleanHistory = history.filter((h) => {
        // Lọc tool response không có assistant tool_calls đi kèm
        if (h.role === "tool") return assistantToolCallIds.has(h.tool_call_id);
        // Lọc assistant tool_calls mà thiếu tool response
        if (h.role === "assistant" && h.tool_calls?.length) {
            return h.tool_calls.every((tc) => toolResponseIds.has(tc.id));
        }
        return true;
    });

    const messages = [];
    const addedToolCallIds = new Set();

    for (const h of cleanHistory) {
        if (h.role === "tool") {
            if (!addedToolCallIds.has(h.tool_call_id)) {
                messages.push({role: "tool", tool_call_id: h.tool_call_id, content: h.content});
                addedToolCallIds.add(h.tool_call_id);
            }
            continue;
        }

        const msg = {role: h.role};
        if (h.role === "assistant" && h.tool_calls) {
            msg.content = null;
            msg.tool_calls = h.tool_calls;
            messages.push(msg);
            
            for (const tc of h.tool_calls) {
                const toolMsgs = cleanHistory.filter((t) => t.role === "tool" && t.tool_call_id === tc.id);
                for (const tm of toolMsgs) {
                    if (!addedToolCallIds.has(tm.tool_call_id)) {
                        messages.push({role: "tool", tool_call_id: tm.tool_call_id, content: tm.content});
                        addedToolCallIds.add(tm.tool_call_id);
                    }
                }
            }
        } else {
            if (h.file_id) {
                const url = await getTelegramFileUrl(h.file_id);
                msg.content = [{type: "text", text: h.content || ""}];
                if (url) msg.content.push({type: "image_url", image_url: {url}});
            } else msg.content = h.content;
            messages.push(msg);
        }
    }

    async function processModelResponse(currentMessages) {
        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{role: "system", content: SYSTEM_PROMPT}, ...currentMessages],
            tools: TOOLS,
        });
        const respMsg = res.choices[0].message;
        if (respMsg.tool_calls?.length) {
            currentMessages.push(respMsg);
            addToHistory(chatId, "assistant", null, respMsg.tool_calls);
            for (const call of respMsg.tool_calls) {
                let toolInput = {};
                try {
                    toolInput = JSON.parse(call.function.arguments);
                } catch (e) {
                    console.error("Lỗi parse arguments:", e);
                }
                const result = await executeTool(call.function.name, toolInput, chatId);
                currentMessages.push({role: "tool", tool_call_id: call.id, content: result});
                addToHistory(chatId, "tool", result, null, call.id);
            }
            return processModelResponse(currentMessages);
        }
        return respMsg.content || "";
    }

    const text = await processModelResponse(messages);
    addToHistory(chatId, "assistant", text);
    return text;
}

// JOBS
async function sendTaskReport(chatId, title = "buổi sáng") {
    const allTasks = await getAllTasks({statuses: ["to do", "in progress"]});
    
    let completedTasksToday = [];
    if (title === "cuối ngày") {
        completedTasksToday = await getCompletedTasksToday();
    }

    const now = new Date().toLocaleString("vi-VN", {timeZone: "Asia/Ho_Chi_Minh"});
    const header = `📋 Báo cáo task ${title} (${now}):`;
    addToHistory(String(chatId), "assistant", header);

    // Reset danh sách task cho chat này
    lastTaskList[String(chatId)] = [];
    let globalIndex = 1;

    for (const [tgUser, cuId] of Object.entries(userMapping)) {
        const tasks = allTasks.filter((t) => t.assignees?.some((a) => Number(a.id) === Number(cuId)));
        let completedMsgs = [];
        if (title === "cuối ngày") {
            const completed = completedTasksToday.filter((t) => t.assignees?.some((a) => Number(a.id) === Number(cuId)));
            if (completed.length > 0) {
                completedMsgs.push(`✅ Đã hoàn thành hôm nay (${completed.length} task):\n${formatTaskList(completed)}`);
            }
        }

        if (tasks.length > 0 || completedMsgs.length > 0) {
            if (tasks.length > 0) {
                tasks.forEach((t) => {
                    lastTaskList[String(chatId)].push({index: globalIndex++, taskId: t.id, taskName: t.name});
                });
            }
            
            let msg = `@${tgUser}: (${tasks.length} task đang làm)`;
            if (tasks.length > 0) {
                msg += `\n${formatTaskList(tasks)}`;
            } else {
                msg += `\nKhông có task đang làm`;
            }

            if (completedMsgs.length > 0) {
                msg += `\n\n${completedMsgs[0]}`;
            }

            await sendTelegramMessage(chatId, msg);
            addToHistory(String(chatId), "assistant", msg);
        } else {
            const msg = `@${tgUser}: Không có task nào`;
            await sendTelegramMessage(chatId, msg);
            addToHistory(String(chatId), "assistant", msg);
        }
    }
}

async function sendDeadlineReminder(chatId) {
    const [upcoming, overdue] = await Promise.all([getUpcomingDeadlineTasks(2), getOverdueTasks()]);
    const now = new Date().toLocaleString("vi-VN", {timeZone: "Asia/Ho_Chi_Minh"});
    const msgs = [];

    if (overdue.length) {
        msgs.push(`⚠️ Task QUÁ HẠN (${now}):\n${groupTasksByUser(overdue, true)}`);
    }
    if (upcoming.length) {
        msgs.push(`⏰ Task SẮP ĐẾN HẠN trong 2 ngày (${now}):\n${groupTasksByUser(upcoming, true)}`);
    }

    if (!msgs.length) {
        const okMsg = "✅ Không có task quá hạn hay sắp đến hạn.";
        await sendTelegramMessage(chatId, okMsg);
        addToHistory(String(chatId), "assistant", okMsg);
        return;
    }

    for (const msg of msgs) {
        await sendTelegramMessage(chatId, msg);
        addToHistory(String(chatId), "assistant", msg);
    }
}

function scheduleJobs() {
    const reportChatId = process.env.REPORT_CHAT_ID;
    if (!reportChatId) {
        console.log("⚠️ Chưa cấu hình REPORT_CHAT_ID, bỏ qua scheduled jobs.");
        return;
    }
    const reportChats = [reportChatId];

    // Báo cáo task + nhắc nhở buổi sáng lúc 8h (giờ VN)
    schedule.scheduleJob({hour: 8, minute: 0, tz: "Asia/Ho_Chi_Minh"}, async () => {
        for (const id of reportChats) {
            await sendTelegramMessage(
                id,
                "🌅 Chào buổi sáng mọi người! Đừng quên update tình hình các task hôm nay nhé.\nAnh/chị nào có task mới hoặc thay đổi thì tag @BruceShark12_bot để em cập nhật lên ClickUp cho ạ 💪",
            ).catch((e) => console.error(e));
            await sendTaskReport(id).catch((e) => console.error(e));
        }
    });

    // Nhắc deadline + nhắc nhở buổi chiều lúc 16h50 (giờ VN)
    schedule.scheduleJob({hour: 16, minute: 50, tz: "Asia/Ho_Chi_Minh"}, async () => {
        for (const id of reportChats) {
            await sendDeadlineReminder(id).catch((e) => console.error(e));
            await sendTaskReport(id, "cuối ngày").catch((e) => console.error(e));
            await sendTelegramMessage(
                id,
                "🌆 Cuối ngày rồi mọi người ơi! Nhớ update lại tiến độ các task hôm nay trước khi nghỉ nhé.\nTask nào xong thì báo em để em đánh dấu complete cho ạ ✅",
            ).catch((e) => console.error(e));
        }
    });

    console.log("✅ Jobs scheduled: báo cáo 8h sáng, nhắc deadline 16h50 chiều.");
}

// WEBHOOK
app.post("/webhook", async (req, res) => {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);
    rememberGroupChatId(message);
    const chatId = message.chat.id;
    const sender = getSenderName(message);
    const text = message.text || message.caption || "";
    let fileId = message.photo?.length ? message.photo[message.photo.length - 1].file_id : null;
    if (!text && !fileId) return res.sendStatus(200);

    const isTagged = text.includes(`@${BOT_USERNAME}`) || message.reply_to_message?.from?.username === BOT_USERNAME;
    if (!isTagged) {
        addToHistory(String(chatId), "user", text ? `${sender}: ${text}` : `${sender}: (gửi hình ảnh)`, null, null, fileId);
        return res.sendStatus(200);
    }
    const cleanText = text.replace(new RegExp(`@${BOT_USERNAME}`, "g"), "").trim();
    try {
        const reply = await getAIResponse(String(chatId), cleanText, sender, fileId);
        await sendTelegramMessage(chatId, reply);
    } catch (err) {
        console.error(err);
    }
    return res.sendStatus(200);
});

app.get("/health", (req, res) => res.json({ok: true}));

app.post("/test-report", async (req, res) => {
    const chatId = process.env.REPORT_CHAT_ID || req.body?.chat_id;
    if (!chatId) return res.status(400).json({ok: false, message: "Chưa cấu hình REPORT_CHAT_ID"});
    const type = req.body?.type || "morning";
    try {
        if (type === "morning") {
            await sendTelegramMessage(
                chatId,
                "🌅 Chào buổi sáng mọi người! Đừng quên update tình hình các task hôm nay nhé.\nAnh/chị nào có task mới hoặc thay đổi thì tag @BruceShark12_bot để em cập nhật lên ClickUp cho ạ 💪",
            );
            await sendTaskReport(chatId);
            res.json({ok: true, message: "Đã gửi báo cáo sáng"});
        } else if (type === "afternoon") {
            await sendDeadlineReminder(chatId);
            await sendTaskReport(chatId, "cuối ngày");
            await sendTelegramMessage(
                chatId,
                "🌆 Cuối ngày rồi mọi người ơi! Nhớ update lại tiến độ các task hôm nay trước khi nghỉ nhé.\nTask nào xong thì báo em để em đánh dấu complete cho ạ ✅",
            );
            res.json({ok: true, message: "Đã gửi báo cáo chiều"});
        } else {
            res.status(400).json({ok: false, message: "type phải là 'morning' hoặc 'afternoon'"});
        }
    } catch (err) {
        console.error("Test report error:", err.response?.data || err.message);
        res.status(500).json({ok: false, message: err.response?.data?.description || err.message});
    }
});

app.post("/clear-conversations", (req, res) => {
    conversations = {};
    saveConversations();
    console.log("🧹 Conversations cleared via API");
    res.json({ok: true, message: "Conversations cleared"});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🤖 Bot running on port ${PORT}`);
    conversations = loadConversations();
    if (process.env.CLEAR_CONVERSATIONS_ON_START === "true") {
        conversations = {};
        saveConversations();
        console.log("🧹 Conversations cleared on startup");
    }
    const savedIds = loadSavedGroupChatIds();
    savedIds.forEach((id) => {
        if (!groupChatIds.includes(id)) groupChatIds.push(id);
    });
    try {
        await setTelegramWebhook();
    } catch (e) {
        console.error("setWebhook error:", e.message);
    }
    scheduleJobs();

    // Test local: gửi cả báo cáo sáng + nhắc deadline chiều ngay khi khởi động
    if (process.env.NODE_ENV !== "production") {
        const testChatId = "-5123210368";
        console.log("🧪 Đang chạy local → test báo cáo sáng...");
        await sendTelegramMessage(
            testChatId,
            "🌅 Chào buổi sáng mọi người! Đừng quên update tình hình các task hôm nay nhé.\nAnh/chị nào có task mới hoặc thay đổi thì tag @BruceShark12_bot để em cập nhật lên ClickUp cho ạ 💪",
        ).catch((e) => console.error(e));
        await sendTaskReport(testChatId).catch((e) => console.error(e));

        console.log("🧪 Đang chạy local → test nhắc deadline chiều...");
        await sendDeadlineReminder(testChatId).catch((e) => console.error(e));
        await sendTelegramMessage(
            testChatId,
            "🌆 Cuối ngày rồi mọi người ơi! Nhớ update lại tiến độ các task hôm nay trước khi nghỉ nhé.\nTask nào xong thì báo em để em đánh dấu complete cho ạ ✅",
        ).catch((e) => console.error(e));
    }
});
