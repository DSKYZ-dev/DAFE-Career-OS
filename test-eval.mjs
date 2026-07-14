import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from 'dotenv';
config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function test() {
  const prompt = `You are a career advisor evaluating a job offer.

Job Title: Customer Support Specialist
Company: Test Corp
URL: https://example.com/job

Job Description:
We are looking for a Customer Support Specialist to join our team. Requirements: High school diploma, 1+ years customer service experience, excellent communication skills, ability to work remote.

Evaluate this position using the A-G scoring system:
A. Role Alignment (0-10): Does the role match the user's career trajectory?
B. Compensation & Benefits (0-10): Salary range, benefits, equity
C. Growth Potential (0-10): Learning, advancement, mentorship
D. Company Health (0-10): Financial stability, reputation, culture
E. Location & Logistics (0-10): Remote policy, hours, commute
F. Personal Fit (0-10): Values alignment, team, work style
G. Posting Legitimacy (0-10): Real posting, no red flags

First output a JSON block:
\`\`\`json
{
  "score": <overall 1-5>,
  "scores": { "role": <0-10>, "compensation": <0-10>, "growth": <0-10>, "company": <0-10>, "location": <0-10>, "fit": <0-10>, "legitimacy": <0-10> },
  "recommendation": "<Strong Apply | Apply | Consider | Skip>",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "tldr": "<one line summary>"
}
\`\`\`

Then write a full evaluation report in markdown.`;

  try {
    const result = await genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }).generateContent(prompt);
    console.log('Response length:', result.response.text().length);
    console.log('Response:', result.response.text());
  } catch (e) { console.error(e.message); }
}

test();