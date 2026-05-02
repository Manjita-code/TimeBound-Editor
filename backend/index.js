const express = require("express");
const cors = require("cors");
const client = require("./redisClient");

const app = express();
const PORT = process.env.PORT || 3001;
const memoryUsers = new Map();
let nextMemoryId = 1;
const EDITABLE_FIELDS = ["name", "email", "age"];
const MAX_FIELD_EDITS = 2;

app.use(cors());
app.use(express.json());

function sanitizeUserPayload(body = {}) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const age = Number(body.age);

  if (!name || !email || Number.isNaN(age) || age <= 0) {
    return null;
  }

  return { name, email, age };
}

function canUseRedis() {
  return client.isOpen && client.isReady;
}

function getDefaultEditCounts() {
  return {
    name: 0,
    email: 0,
    age: 0
  };
}

function normalizeUserRecord(user) {
  if (!user) {
    return null;
  }

  return {
    ...user,
    // updatedAt:user.updatedAt|| 0,   //updatedat feild for sorting by update time
    fieldUpdatedAt: {
  name: user.fieldUpdatedAt?.name || 0,
  email: user.fieldUpdatedAt?.email || 0,
  age: user.fieldUpdatedAt?.age || 0
  },
    editCounts: {
      ...getDefaultEditCounts(),
      ...(user.editCounts || {})
    }
  };
}

function getExceededFields(existingUser, nextUserData) {
  const currentUser = normalizeUserRecord(existingUser);
  const exceededFields = [];

  for (const field of EDITABLE_FIELDS) {
    const hasChanged = currentUser[field] !== nextUserData[field];

    if (!hasChanged) {
      continue;
    }

    if ((currentUser.editCounts[field] || 0) >= MAX_FIELD_EDITS) {
      exceededFields.push(field);
    }
  }

  return exceededFields;
}

function buildUpdatedUser(existingUser, nextUserData, id) {
  const currentUser = normalizeUserRecord(existingUser);
  const editCounts = { ...currentUser.editCounts };

   const fieldUpdatedAt = { ...currentUser.fieldUpdatedAt };

  for (const field of EDITABLE_FIELDS) {
    if (currentUser[field] !== nextUserData[field]) {
      editCounts[field] += 1;
      fieldUpdatedAt[field] = Date.now();  // for updated user update time for each field
    }
  }

  return {
    id: Number(id),
    ...nextUserData,
    editCounts,
    fieldUpdatedAt,
    updatedAt: Date.now()      //update for time
  };
}

async function createUserRecord(userData) {
  if (canUseRedis()) {
    const id = await client.incr("user:id");
    const user = { id, ...userData, editCounts: getDefaultEditCounts() };
    await client.set(`user:${id}`, JSON.stringify(user));
    return user;
  }

  const user = {
    id: nextMemoryId++,
    ...userData,
    editCounts: getDefaultEditCounts(),
    // updatedAt: Date.now()               //update for time
    fieldUpdatedAt: {   //for every field we need make object inside obejct
    name: Date.now(),
    email: Date.now(),
    age: Date.now()
  }
  };
  memoryUsers.set(String(user.id), user);
  return user;
}

async function getAllUserRecords() {
  if (canUseRedis()) {
    const keys = await client.keys("user:*");
    const users = [];

    for (const key of keys) {
      if (key === "user:id") continue;

      const data = await client.get(key);

      if (!data) continue;

      try {
        const parsed = JSON.parse(data);

        if (parsed && parsed.id) {
          users.push(normalizeUserRecord(parsed));
        }
      } catch {
        // Ignore invalid values.
      }
    }

    return users.sort((a, b) => Number(a.id) - Number(b.id));
  }

  return Array.from(memoryUsers.values())
    .map(normalizeUserRecord)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

async function getUserRecord(id) {
  if (canUseRedis()) {
    const data = await client.get(`user:${id}`);
    return data ? normalizeUserRecord(JSON.parse(data)) : null;
  }

  return normalizeUserRecord(memoryUsers.get(String(id)) || null);
}

async function updateUserRecord(id, existingUser, userData) {
  const user = buildUpdatedUser(existingUser, userData, id);

  if (canUseRedis()) {
    await client.set(`user:${id}`, JSON.stringify(user));
    return user;
  }

  memoryUsers.set(String(id), user);
  return user;
}

app.post("/redis/user", async (req, res) => {
  console.log("Redis working", canUseRedis());
  try {
    const payload = sanitizeUserPayload(req.body);

    if (!payload) {
      return res.status(400).json({ message: "Please enter valid user details" });
    }

    const user = await createUserRecord(payload);
    return res.json({ message: "User created", user });
  } catch (err) {
    console.log("Create user error:", err);
    return res.status(500).json({ message: "Error saving user" });
  }
  
});

app.get("/redis/users", async (req, res) => {
  try {
    const users = await getAllUserRecords();
    return res.json(users);
  } catch (err) {
    console.log("Get users error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

app.get("/redis/user/:id", async (req, res) => {
  try {
    const user = await getUserRecord(req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json(user);
  } catch (err) {
    console.log("Get user error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

app.put("/redis/user/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const payload = sanitizeUserPayload(req.body);

    if (!payload) {
      return res.status(400).json({ message: "Please enter valid user details" });
    }

    const existingUser = await getUserRecord(id);

    if (!existingUser) {
      return res.status(404).json({ message: "User not found" });
    }
    //time logic to resttrict user
    // const currentTime= Date.now();
    // const diff=currentTime-existingUser.updatedAt; 

    // if(diff<60000){
    //   const remainingTime=Math.ceil((60000-diff)/1000);
    //   return res.status(400).json({
    //     message: `User was updated recently.Please wait ${remainingTime} seconds before updating again.`
    //   });
    // }

    //time logic to resttrict user
    const currentTime = Date.now();
    const blockedFields = [];
    let remainingTime=0;

    for (const field of EDITABLE_FIELDS) {
    const hasChanged = existingUser[field] !== payload[field];

    if (!hasChanged) continue;

    const lastUpdate = existingUser.fieldUpdatedAt?.[field] || 0;
    const diff = currentTime - lastUpdate;

    if (diff < 60000) {
    remainingTime=Math.ceil((60000-diff)/1000);
    blockedFields.push(field);
    }
}
if (blockedFields.length > 0) {
  return res.status(400).json({
    message: `User was updated recently. Please wait ${remainingTime} seconds`
  });
}

// if (blockedFields.length > 0) {
//   return res.status(400).json({
//     message: `User was updated recently.Please wait ${remainingTime} seconds before updating again.`
//     // message: `${blockedFields.join(", ")} cannot be edited yet (wait 60 sec)`
//   });
// }


    const exceededFields = getExceededFields(existingUser, payload);

    if (exceededFields.length > 0) {
      return res.status(400).json({
        message: `${exceededFields.join(", ")} limit exceeds`
      });
    }

    const user = await updateUserRecord(id, existingUser, payload);
    return res.json({ message: "User updated", user });
  } catch (err) {
    console.log("Update user error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
