# Kết nối agent cho Trạm Công nghệ

Giao diện hiện là demo, có thể kết nối cổng HTTP và gửi tác vụ văn bản thật khi bạn cấu hình một agent upstream. Cổng này không tự tạo một dịch vụ AI, không thực thi mã nguồn, không cung cấp sandbox hoặc tạo sản phẩm web tự động.

## Phần đã có

- Giao diện kiểm tra sức khỏe cổng, tải danh sách agent và gán cho 12 vai trò Phi Phi.
- Gửi yêu cầu rõ ràng tới agent đã gán; chọn có gửi kèm tri thức dự án hay không.
- Kết quả thật được lưu riêng với tài liệu mô phỏng.
- Gateway Node.js không có dependency bổ sung, dùng token truy cập riêng, danh sách origin cho phép, giới hạn kích thước, thời gian và số tác vụ đồng thời.

## Những gì bạn cần cung cấp

1. Một endpoint agent/webhook bạn kiểm soát. Nó nhận JSON theo hợp đồng dưới đây và gọi dịch vụ AI/công cụ của bạn.
2. Token của endpoint đó nếu có. Đặt bằng biến môi trường trên máy chạy gateway, không nhập khóa model vào giao diện.
3. Một token ngẫu nhiên riêng cho gateway. Chỉ nhập token gateway trong giao diện; token không lưu qua lần tải lại.

Có thể dùng một agent chung rồi gán cho nhiều vai trò. Không cần tạo 12 tài khoản AI hoặc chạy 12 agent cùng lúc.

## Chạy cục bộ bằng PowerShell

Sao chép `gateway/agents.example.json` thành file cấu hình của bạn, thay endpoint mẫu bằng endpoint thật. Giữ file cấu hình và bí mật ngoài Git.

```powershell
$env:TRAM_AGENTS_FILE = 'D:\duong-dan-rieng\agents.json'
$env:TRAM_GATEWAY_TOKEN = '<token-gateway-tu-tao>'
$env:MY_AGENT_TOKEN = '<token-upstream-neu-can>'
node gateway/server.mjs
```

Gateway mặc định chỉ nghe `127.0.0.1:4320`, không mở ra mạng LAN. Trong giao diện, mở **Kết nối AI / Agent**, nhập địa chỉ cổng và token gateway, kiểm tra, gán vai trò rồi gửi tác vụ.

Trình duyệt có thể chặn kết nối từ website HTTPS tới máy cục bộ hoặc yêu cầu quyền truy cập mạng cục bộ. Khi đó dùng giao diện preview trên cùng máy hoặc triển khai gateway sau HTTPS với đăng nhập. Không vô hiệu hóa bảo vệ trình duyệt để kết nối.

Để chia sẻ cho nhóm nhỏ cần host gateway, tài khoản và dữ liệu tập trung. Chưa có những thành phần này; việc chia sẻ website hiện không đồng bộ dự án. Chỉ xuất/nhập file bản chụp dự án được hỗ trợ.

## Hợp đồng upstream

Gateway gửi POST tới endpoint đã cấu hình:

```json
{
  "agentId": "my-agent",
  "roleId": "TC-003",
  "projectId": "project-example",
  "task": "Soạn đặc tả MVP theo yêu cầu...",
  "context": {"projectName": "Ứng dụng mẫu", "knowledge": "Tài liệu được phép gửi"}
}
```

Upstream phải trả:

```json
{"status":"completed","output":"Nội dung đầu ra dạng văn bản"}
```

Yêu cầu giới hạn 120 giây, tối đa hai tác vụ đồng thời. Chưa hỗ trợ tác vụ nền dài, streaming, retry tự động hoặc hủy upstream theo phiên. Timeout không chứng minh upstream đã ngừng; kiểm tra hệ thống agent trước khi gửi lại để tránh chạy trùng.

## Để đi từ ý tưởng đến sản phẩm thật

Bước kế tiếp cần backend lưu trạng thái + hàng đợi, worker có Git workspace cô lập, công cụ tạo file/build/test, kho artifact và preview. Mỗi lần hoàn tất cần có mã nguồn, lệnh kiểm thử, log kết quả và URL bản chạy thử. Không dùng văn bản do AI tự báo để thay thế bằng chứng chạy công cụ.
