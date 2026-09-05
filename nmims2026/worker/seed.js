// 初期データ。管理者1名のみ。パスワードは元の videoeval（awec2026）と同じ（ハッシュを引き継いでいる）。
// 学生は /register/ から自分で登録する。
export const SEED_USERS = [
  {"email": "shunokuhara@icloud.com", "name": "奥原 駿", "student_id": "", "role": "admin", "pw_salt": "df7d0f112f421e0c9527099f585e1044", "pw_hash": "866f0df4cfbccf5d8661d9ce1079b3c634ca14356d8490840716eeeb659fce88", "seed": 3991021268},
];
