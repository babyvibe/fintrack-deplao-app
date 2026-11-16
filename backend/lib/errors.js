'use strict';
/**
 * Errors with a code + a plain Vietnamese message. The UI only shows `message`; `code` is for case-by-case handling.
 * Never put secrets, headers or request content into a message.
 */

class PluginError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

/** Guidance messages for Deplao error codes (API v1 + deplao.cloudflare). */
const DEPLAO_HINTS = {
  API_DISABLED: 'API của Deplao đang tắt. Bật ở Công cụ → Ứng dụng, API & Webhook → API.',
  FORBIDDEN_SCOPE: 'Ứng dụng chưa được cấp đủ quyền. Cài lại ứng dụng để duyệt quyền mới.',
  PLUGIN_PERMISSION: 'Ứng dụng chưa được cấp quyền triển khai lên Cloudflare. Cài lại ứng dụng để duyệt quyền.',
  FORBIDDEN_ACCOUNT: 'Ứng dụng không được dùng tài khoản này. Đổi phạm vi tài khoản trong chi tiết ứng dụng.',
  ACCOUNT_OFFLINE: 'Tài khoản Zalo đang ngắt kết nối. Kết nối lại trong Deplao rồi thử lại.',
  CHANNEL_UNSUPPORTED: 'Kênh này không hỗ trợ thao tác đó (chỉ dùng tài khoản Zalo).',
  CF_NAME_FORBIDDEN: 'Tên Worker/D1 không đúng tiền tố "fintrack" của ứng dụng.',
  CF_BUNDLE_INVALID: 'Gói FinTrack đi kèm ứng dụng bị lỗi. Cài lại bản phát hành đầy đủ.',
  RATE_LIMITED: 'Đang gọi quá nhanh. Đợi một chút rồi thử lại.',
  TIMEOUT: 'Hết thời gian chờ. Thử lại sau.',
};

/** Generic Deplao codes: keep the original message (already Vietnamese), add a lead-in / a plain fallback. */
const GENERIC = {
  VALIDATION_ERROR: { lead: 'Dữ liệu không hợp lệ', fallback: 'Dữ liệu gửi đi không hợp lệ. Tải lại trang rồi thử lại.' },
  NOT_FOUND: { lead: 'Không tìm thấy', fallback: 'Không tìm thấy dữ liệu (có thể đã bị xoá). Tải lại trang rồi thử lại.' },
  CONFLICT: { lead: '', fallback: 'Đang có thao tác khác chạy hoặc dữ liệu vừa thay đổi. Đợi một chút rồi thử lại.' },
  CF_API: { lead: 'Cloudflare báo lỗi', fallback: 'Cloudflare báo lỗi. Thử lại sau ít phút.' },
  // Deplao tells "not connected" apart from "token no longer valid": keep Deplao's message.
  CF_NOT_CONNECTED: { lead: '', fallback: 'Deplao chưa kết nối Cloudflare. Mở Cài đặt → Internet & Đám mây → Kết nối Cloudflare.' },
  UPSTREAM_ERROR: { lead: '', fallback: 'Dịch vụ bên ngoài không phản hồi. Thử lại sau.' },
  // The user pressed "Không" (No) in Deplao's attach-domain dialog: keep Deplao's message.
  CF_DECLINED: { lead: '', fallback: 'Bạn đã chọn "Không" ở hộp thoại của Deplao nên chưa gắn tên miền.' },
};

/**
 * Any error → { code, message } for the UI. Deplao's own messages are already Vietnamese;
 * for a few codes we substitute clearer guidance.
 */
function describeError(err) {
  if (!err) return { code: 'UNKNOWN', message: 'Lỗi không rõ' };
  const code = String(err.code || 'ERROR');
  const raw = String(typeof err === 'string' ? err : err.message ?? '').trim();
  if (err instanceof PluginError) return { code, message: raw };
  if (code === 'CF_PERMISSION') {
    return { code, message: `${raw || 'Token Cloudflare thiếu quyền.'} Cập nhật token ở Cài đặt → Internet & Đám mây → Kết nối Cloudflare.` };
  }
  if (DEPLAO_HINTS[code]) return { code, message: DEPLAO_HINTS[code] };
  const g = GENERIC[code];
  if (g) {
    if (!raw) return { code, message: g.fallback };
    const already = !g.lead || raw.toLowerCase().startsWith(g.lead.toLowerCase());
    return { code, message: already ? raw : `${g.lead}: ${raw}` };
  }
  return { code, message: raw || 'Lỗi không rõ' };
}

module.exports = { PluginError, describeError };
