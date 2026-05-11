import { getClient } from "../services/line-bot.js";
import { env } from "../config/env.js";

// Ensure env loads
if (!env.LINEJS_TEST_ENABLED) {
  console.error("❌ ข้ามการทำงาน: ต้องเปิดใช้งาน LINEJS_TEST_ENABLED=true ใน .env หรือตั้งค่าผ่านหน้าเว็บก่อน");
  process.exit(1);
}

async function main() {
  try {
    console.log("⏳ กำลังเชื่อมต่อ LINE Bot...");
    const client = await getClient();
    
    console.log("✅ เชื่อมต่อสำเร็จ! กำลังดึงรายชื่อแชท...");
    
    // ดึง MIDs ของแชททั้งหมด
    const midsRes = await client.base.talk.getAllChatMids({ 
      syncReason: "internal", 
      request: { withMemberChats: true } 
    });
    
    const mids = midsRes.memberChatMids || [];
    if (mids.length === 0) {
      console.log("❌ ไม่พบแชทใดๆ");
      process.exit(0);
    }

    // ดึงรายละเอียดชื่อแชท
    const chatsRes = await client.base.talk.getChats({ chatMids: mids });
    const chats = chatsRes.chats || [];

    console.log("\n================ รายชื่อกลุ่ม (Groups) ================");
    let count = 0;
    for (const chat of chats) {
      // Group MIDs จะขึ้นต้นด้วยตัว c
      if (chat.chatMid && chat.chatMid.startsWith("c")) {
        count++;
        console.log(`📌 ชื่อกลุ่ม: ${chat.chatName || 'ไม่ทราบชื่อ'}`);
        console.log(`🔑 MID:    ${chat.chatMid}`);
        console.log("-----------------------------------------------------");
      }
    }
    
    if (count === 0) {
      console.log("❌ ไม่พบกลุ่มใดๆ ที่คุณเป็นสมาชิกอยู่");
    } else {
      console.log(`✅ พบทั้งหมด ${count} กลุ่ม`);
      console.log("👉 ก๊อปปี้ 'MID' ที่ต้องการ ไปใส่ในช่อง Target MID ได้เลยครับ");
    }
    console.log("=====================================================\n");
    
    process.exit(0);
  } catch (error) {
    console.error("❌ เกิดข้อผิดพลาด:", error);
    process.exit(1);
  }
}

main();
