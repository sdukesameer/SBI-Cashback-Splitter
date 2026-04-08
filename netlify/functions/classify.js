exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not configured in Netlify environment variables.' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify(body)
        });

        const data = await groqRes.json();

        if (!groqRes.ok) {
            return {
                statusCode: groqRes.status,
                body: JSON.stringify({ error: data.error?.message || 'Groq API error' })
            };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        };
    } catch (err) {
        return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
    }
};
