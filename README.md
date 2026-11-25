# Cẩm Nang Tư Vấn Mầm Non Chuyển Giao — NovaStars (`web-dao-tao-sale`)

> **Trực tiếp (GitHub Pages):** [https://linhmeo95.github.io/web-dao-tao-sale/](https://linhmeo95.github.io/web-dao-tao-sale/)  
> **Cơ sở dữ liệu đám mây:** Supabase (`novastars_app_state` table, namespace `sale_training__*`)  
> **Mã PIN Quản lý (Admin):** `8888`  
> **Điểm chuẩn Hoàn thành bài học:** `>= 80%`

---

## 1. Phân quyền 3 Đối tượng Sử dụng & Mã PIN Mặc định

### A. Người học — Nhân viên Sale (`role: "sale"`)
Đăng nhập để đọc tài liệu đào tạo chương trình mầm non chuyển giao và làm bài tập trắc nghiệm kiểm tra tiến độ (cần đạt $\ge 80\%$ để tính Hoàn thành; được phép làm lại nhiều lần):

| STT | Họ và Tên Sale | Mã Định Danh (`id`) | Mã PIN |
| :---: | :--- | :--- | :---: |
| 1 | **Triệu Thị Tiên** | `sale-tientt` | `1111` |
| 2 | **Tô Phương Diễm** | `sale-diempt` | `2222` |
| 3 | **Đinh Thị Hương** | `sale-huongdt` | `3333` |
| 4 | **Nguyễn Minh Tú** | `sale-tunm` | `5555` |
| 5 | **Lê Thị Lan Anh** | `sale-lananh` | `6666` |

### B. Người up nội dung (`role: "uploader"`)
Đăng nhập để tải tài liệu mới (`.docx`, `.xlsx`, `.pdf`, `.txt`), kích hoạt công cụ chuyển đổi tài liệu sang câu hỏi trắc nghiệm theo 4 tiêu chí chuẩn, tải lên bộ câu hỏi trắc nghiệm có sẵn, xem trước và chỉnh sửa câu hỏi:

| STT | Họ và Tên | Mã Định Danh (`id`) | Mã PIN |
| :---: | :--- | :--- | :---: |
| 1 | **Phạm Mỹ Linh** | `up-linhpm` | `4444` |
| 2 | **Ban Đào Tạo Sản Phẩm** | `up-daotao` | `7777` |

### C. Quản lý (`role: "admin"`)
- **Mã PIN Quản lý:** `8888`
- Toàn quyền theo dõi **Bảng Ma trận Tiến độ & Điểm Trắc nghiệm của Sale**, xem chi tiết từng lần thi của từng Sale, thống kê câu hỏi khó, quản lý danh sách nhân sự & mã PIN, xuất ảnh **Bảng Tên + Mã PIN** gửi nhóm chat và xuất báo cáo Excel (`.xlsx`).

---

## 2. Danh sách 4 Học phần & Bộ Câu hỏi Trắc nghiệm Tích hợp sẵn

1. **HP01** — *So sánh Tổng quan Chương trình Bộ GD&ĐT và Kĩ năng sống Novastars (72 tiết)* (Kèm 10 câu hỏi trắc nghiệm).
2. **HP02** — *6 Lý Do Thuyết Phục Chủ Trường: Vì sao Cô giáo dễ dạy nhưng không thể tự soạn được như Novastars?* (Kèm 8 câu hỏi trắc nghiệm).
3. **HP03** — *Kịch bản Phân tích 10 Bài Học Mẫu (Khối Bé – Nhỡ – Lớn) để Dẫn chứng với Hiệu trưởng* (Kèm 10 câu hỏi trắc nghiệm).
4. **HP04** — *Lộ Trình 3 Độ Tuổi & Danh Sách Đủ 72 Tiết × 3 Khối Chính Khóa để Sale Tra cứu* (Kèm 8 câu hỏi trắc nghiệm).

---

## 3. Hướng dẫn Chạy Cục bộ & Triển khai Vercel

### Chạy trên máy (Local Server):
```bash
cd "web-dao-tao-sale"
python3 server.py
```
Truy cập tại: `http://localhost:8787`
