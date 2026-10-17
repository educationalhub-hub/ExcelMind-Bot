import jwt from "jsonwebtoken";
const JWT_SECRET = process.env.JWT_SECRET;
const token = jwt.sign({ uid: 2, email: "awololadaniel9@gmail.com", role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
console.log(token);
