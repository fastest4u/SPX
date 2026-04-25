// Native fetch is available in Node 18+
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
function runTests() {
    return __awaiter(this, void 0, void 0, function () {
        var API, loginRes, rawCookie, tokenCookie, baseHeaders, jsonHeaders, username, createRes, text, usersRes, users, testUser, changePwdRes, auditRes, logs, deleteRes, text, logoutRes;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    API = 'http://localhost:3000/api';
                    console.log('--- Starting API Tests ---');
                    return [4 /*yield*/, fetch("".concat(API, "/login"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ username: 'admin', password: 'admin123' })
                        })];
                case 1:
                    loginRes = _a.sent();
                    if (!loginRes.ok)
                        throw new Error('Login failed');
                    rawCookie = loginRes.headers.get('set-cookie') || '';
                    console.log('Raw cookie:', rawCookie);
                    tokenCookie = rawCookie.split(';')[0];
                    console.log('Token cookie:', tokenCookie);
                    baseHeaders = { 'Cookie': tokenCookie };
                    jsonHeaders = __assign(__assign({}, baseHeaders), { 'Content-Type': 'application/json' });
                    username = 'testuser_' + Date.now();
                    return [4 /*yield*/, fetch("".concat(API, "/users"), {
                            method: 'POST',
                            headers: jsonHeaders,
                            body: JSON.stringify({ username: username, password: 'password123' })
                        })];
                case 2:
                    createRes = _a.sent();
                    if (!!createRes.ok) return [3 /*break*/, 4];
                    return [4 /*yield*/, createRes.text()];
                case 3:
                    text = _a.sent();
                    throw new Error('Create user failed: ' + text);
                case 4:
                    console.log('✅ Create user successful');
                    return [4 /*yield*/, fetch("".concat(API, "/users"), { headers: baseHeaders })];
                case 5:
                    usersRes = _a.sent();
                    return [4 /*yield*/, usersRes.json()];
                case 6:
                    users = _a.sent();
                    testUser = users.find(function (u) { return u.username === username; });
                    if (!testUser)
                        throw new Error('Test user not found in list');
                    console.log("\u2705 Get users successful (Found testuser1 with id ".concat(testUser.id, ")"));
                    return [4 /*yield*/, fetch("".concat(API, "/users/").concat(testUser.id, "/password"), {
                            method: 'PUT',
                            headers: jsonHeaders,
                            body: JSON.stringify({ password: 'newpassword123' })
                        })];
                case 7:
                    changePwdRes = _a.sent();
                    if (!changePwdRes.ok)
                        throw new Error('Change password failed');
                    console.log('✅ Change password successful');
                    return [4 /*yield*/, fetch("".concat(API, "/audit-logs"), { headers: baseHeaders })];
                case 8:
                    auditRes = _a.sent();
                    return [4 /*yield*/, auditRes.json()];
                case 9:
                    logs = _a.sent();
                    if (logs.length < 3)
                        throw new Error('Audit logs missing');
                    console.log('✅ Audit logs retrieved successful (Count: ' + logs.length + ')');
                    console.log('   Latest log: ' + logs[0].action + ' - ' + logs[0].details);
                    return [4 /*yield*/, fetch("".concat(API, "/users/").concat(testUser.id), { method: 'DELETE', headers: baseHeaders })];
                case 10:
                    deleteRes = _a.sent();
                    if (!!deleteRes.ok) return [3 /*break*/, 12];
                    return [4 /*yield*/, deleteRes.text()];
                case 11:
                    text = _a.sent();
                    throw new Error('Delete user failed: ' + text);
                case 12:
                    console.log('✅ Delete user successful');
                    return [4 /*yield*/, fetch("".concat(API, "/logout"), { method: 'POST', headers: baseHeaders })];
                case 13:
                    logoutRes = _a.sent();
                    if (!logoutRes.ok)
                        throw new Error('Logout failed');
                    console.log('✅ Logout successful');
                    console.log('--- All Tests Passed Successfully ---');
                    return [2 /*return*/];
            }
        });
    });
}
runTests().catch(function (e) {
    console.error('❌ Test failed:', e.message);
    process.exit(1);
});
