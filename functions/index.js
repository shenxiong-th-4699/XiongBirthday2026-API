const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = getFirestore("xiong-birthday-2026");

// 1. API: Save Donate (บันทึกข้อมูลแบบละเอียด)
exports.saveDonate = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

        try {
            const d = req.body;
            const newDonate = {
                user_id: d.user_id,
                donator_name: d.donator_name, // ชื่อที่อยากแสดง
                amount: Number(d.amount),
                transferred_date: d.transferred_date, // วันเวลาโอนในสลิป
                bank: d.bank,
                sender_account: d.sender_account, // บัญชีผู้โอน
                sender_name: d.sender_name, // ชื่อผู้โอน
                ref_code: d.ref_code,
                slip_image: d.slip_image, // URL รูป
                status: "pending", // สถานะเริ่มต้นเป็น pending
                created_at: FieldValue.serverTimestamp()
            };

            await db.collection("donate").add(newDonate);
            res.status(200).json({ success: true, message: "บันทึกข้อมูลแล้ว (รอการตรวจสอบ)" });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
});

// 2. API: Get Donation All (แสดงข้อมูลทั้งหมด)
exports.getDonationAll = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const snapshot = await db.collection("donate")
                .orderBy("created_at", "desc")
                .get();

            let allData = [];
            let grandTotal = 0;
            const userIds = new Set();

            // รวบรวม user_id ทั้งหมดก่อนเพื่อไปดึงโปรไฟล์ทีเดียว (Batch Read)
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.user_id) userIds.add(data.user_id);
            });

            const userProfiles = {};
            if (userIds.size > 0) {
                const userIdArray = Array.from(userIds);
                // แบ่งเป็นชุดละ 30 (ขีดจำกัดของ where in ใน Firestore)
                for (let i = 0; i < userIdArray.length; i += 30) {
                    const chunk = userIdArray.slice(i, i + 30);
                    const userSnapshot = await db.collection("users").where("user_id", "in", chunk).get();
                    userSnapshot.forEach(uDoc => {
                        const uData = uDoc.data();
                        userProfiles[uData.user_id] = uData.profile_url || "";
                    });
                }
            }

            snapshot.forEach(doc => {
                const data = doc.data();
                // แปลงเป็น timestamp number
                if (data.created_at && typeof data.created_at.toMillis === 'function') {
                    data.created_at = data.created_at.toMillis();
                }
                if (data.transferred_date && typeof data.transferred_date.toMillis === 'function') {
                    data.transferred_date = data.transferred_date.toMillis();
                }

                // แนบ profile_url เข้าไปในข้อมูล donation
                const donationItem = { 
                    id: doc.id, 
                    ...data,
                    profile_url: userProfiles[data.user_id] || "" 
                };
                
                allData.push(donationItem);
                
                // รวมยอดเฉพาะรายการที่ได้รับการอนุมัติ (approved) เท่านั้น
                if (data.status === "approved") {
                    grandTotal += Number(data.amount || 0);
                }
            });

            res.status(200).json({
                grand_total: grandTotal,
                data: allData
            });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
});

// 3. API: Save User (Check if exists by x_id, then save with Auto ID and return data)
exports.saveUser = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

        try {
            // รับค่า x_id, username, account, และ profile_url
            const { x_id, username, account, profile_url } = req.body;

            if (!x_id) return res.status(400).send("Missing x_id");

            // ค้นหาว่ามี User ที่มี x_id นี้ในระบบหรือยัง
            const usersRef = db.collection("users");
            const snapshot = await usersRef.where("x_id", "==", x_id).limit(1).get();

            let userData;

            if (snapshot.empty) {
                // กรณีไม่มีข้อมูล: สร้างใหม่โดยใช้ Auto ID
                const newUserRef = usersRef.doc(); // สร้าง Auto ID อัตโนมัติ
                const newUserData = {
                    user_id: newUserRef.id, // นำ Auto ID ที่ได้มาเก็บเป็นฟิลด์ user_id
                    x_id,
                    username: username || "",
                    account: account || "",
                    profile_url: profile_url || "", // เก็บรูปโปรไฟล์
                    created_at: FieldValue.serverTimestamp(),
                    last_login: FieldValue.serverTimestamp()
                };
                await newUserRef.set(newUserData);

                // ดึงข้อมูลที่เพิ่งเซฟเพื่อเอาค่า Timestamp ที่แท้จริง
                const savedDoc = await newUserRef.get();
                userData = savedDoc.data();
            } else {
                // กรณีมีข้อมูลอยู่แล้ว: ไม่บันทึกซ้ำ ให้ดึงข้อมูลเดิมกลับไปคืนเลยตามที่คุณต้องการ
                userData = snapshot.docs[0].data();
            }

            // แปลง Timestamp ของ Firestore เป็น Timestamp Number (milliseconds) เพื่อให้แสดงผลใน JSON ได้ถูกต้อง
            if (userData.created_at && typeof userData.created_at.toMillis === 'function') {
                userData.created_at = userData.created_at.toMillis();
            }
            if (userData.last_login && typeof userData.last_login.toMillis === 'function') {
                userData.last_login = userData.last_login.toMillis();
            }

            res.status(200).json({
                success: true,
                data: userData
            });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
});

// 4. API: Get User Info & Donations by x_id
exports.getUserInfoByXid = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

        try {
            const x_id = req.query.x_id;

            if (!x_id) return res.status(400).send("Missing x_id query parameter");

            // 1. หาข้อมูล User ด้วย x_id
            const userSnapshot = await db.collection("users").where("x_id", "==", x_id).limit(1).get();

            if (userSnapshot.empty) {
                return res.status(404).json({
                    success: false,
                    error_code: "USER_NOT_FOUND",
                    message: "ไม่พบข้อมูลผู้ใช้นี้ในระบบ"
                });
            }

            const userData = userSnapshot.docs[0].data();

            // แปลงเวลาให้แสดงผลในรูปแบบ Timestamp Number
            if (userData.created_at && typeof userData.created_at.toMillis === 'function') {
                userData.created_at = userData.created_at.toMillis();
            }
            if (userData.last_login && typeof userData.last_login.toMillis === 'function') {
                userData.last_login = userData.last_login.toMillis();
            }

            // 2. หาประวัติการโดเนททั้งหมดของ User คนนี้ 
            const donationSnapshot = await db.collection("donate")
                .where("user_id", "==", userData.user_id)
                .get();

            let donations = [];
            let totalDonateAmount = 0;

            donationSnapshot.forEach(doc => {
                const data = doc.data();
                if (data.created_at && typeof data.created_at.toMillis === 'function') {
                    data.created_at = data.created_at.toMillis();
                }
                if (data.transferred_date && typeof data.transferred_date.toMillis === 'function') {
                    data.transferred_date = data.transferred_date.toMillis();
                }
                donations.push({ id: doc.id, ...data });
                
                // รวมเฉพาะยอดที่ approved
                if (data.status === "approved") {
                    totalDonateAmount += Number(data.amount || 0);
                }
            });

            // เรียงลำดับจากใหม่ไปเก่า
            donations.sort((a, b) => b.created_at - a.created_at);

            res.status(200).json({
                success: true,
                data: {
                    user_info: userData,
                    total_donate_amount: totalDonateAmount,
                    donations: donations
                }
            });
        } catch (error) {
            console.error("Error in getUserInfoByXid:", error);
            res.status(500).send(error.message);
        }
    });
});

// 5. API: Update Donation Status
exports.updateDonateStatus = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

        try {
            const { donateID, status } = req.body;
            if (!donateID || !status) {
                return res.status(400).json({ success: false, message: "Missing donateID or status" });
            }

            const validStatuses = ['rejected', 'pending', 'approved'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ success: false, message: "Invalid status. Use: rejected, pending, or approved" });
            }

            const donateRef = db.collection("donate").doc(donateID);
            const doc = await donateRef.get();

            if (!doc.exists) {
                return res.status(404).json({ success: false, message: "Donation not found" });
            }

            await donateRef.update({ 
                status: status,
                updated_at: FieldValue.serverTimestamp()
            });

            res.status(200).json({ 
                success: true, 
                message: `Status updated to ${status}`,
                donateID,
                new_status: status
            });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
});