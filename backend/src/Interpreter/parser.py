import os
from pathlib import Path
from dotenv import load_dotenv
from google import genai
from pydantic import BaseModel, Field
from typing import Optional, Literal, List, Dict, Any
from fastapi import FastAPI, HTTPException

# Load backend/.env (two dirs up: backend/src/Interpreter → backend) so
# GEMINI_API_KEY is available no matter how this server is started — `npm run
# ai`, `dev:all`, or `python -m uvicorn parser:app` straight from the venv.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

""""""
# FOR MY TESTING:

app = FastAPI()

"""Request Schema"""
class UserRequest(BaseModel):
    text: str
    chat_event: Dict[str, Any]
    group_roster: Optional[List[str]] = []

# expose endpoint
@app.post("/parse")
def parse_endpoint(request: UserRequest):
    return parse_text(request.chat_event, request.group_roster or [])

"""
Defines the layout of an individual transaction for genAI

    - Container to hold information of a single transaction
    - Can be placed in a shared List for PAYMENT_MULTIPLE
"""
class TransactionDetail(BaseModel):
    recipients: List[str] = Field(
        default=[],
        description=(
            "List of identifiers for the receivers (handles, wallet addresses, phone numbers, or IDs). "
            "If a plain name is used, prioritize matching it to an identifier in the provided roster context."
            "If in a group context, it is implied that all members must be paid or receive money, use all members of group roster except the sender"
            "If the recipient is not known or not clear, default to 'CLARIFY' on the recipient."
        )
    )
    amount: Optional[float] = Field(
        None, description="The exact numerical amount to be sent."
    )
    source_currency: str = Field(
        default="DEFAULT", 
        description="The currency of the sender. STRICT RULE: Set to 'DEFAULT' if the currency is not explicitly and clearly specified (e.g., if they just say '50', '50 bucks', '50 moolah'). Only use standard 3-letter ISO (like ZAR, USD) if the currency name itself is explicitly stated."
    )
    target_currency: str = Field(
        default="DEFAULT",
        description="The currency the receiver must get. STRICT RULE: Set to 'DEFAULT' if the currency is not explicitly and clearly specified. Only use standard 3-letter ISO (like ZAR, USD) if the currency name itself is explicitly stated."
    )
    conversion_type: Literal["NONE", "FIXED_SEND", "FIXED_RECEIVE"] = Field(
        default="NONE",
        description=(
            "Set to FIXED_SEND if the user specifies a fixed amount in their local currency to convert from. "
            "Set to FIXED_RECEIVE if the user explicitly wants the recipient to get an exact fixed amount in a foreign currency. "
            "Set to NONE if both currencies are identical or both default to 'DEFAULT'."
        )
    )

    debtor: str = Field(
        description="The identifier of the person who owes the money. If the sender says 'I owe Sean', the debtor is the sender. If they say 'Sean owes me', the debtor is Sean."
    )
    creditor: str = Field(
        description="The identifier of the person who is owed the money. If the sender says 'I owe Sean', the creditor is Sean. If they say 'Sean owes me', the creditor is the sender."
    )

"""
Define the structural layout of Gemini's responses
Backend can always expect this layout in terms of a JSON

    - Contains user intention
    - List of all transactions to be made
"""
class PaymentIntent(BaseModel):
    intent: Literal["PAYMENT", "PAYMENT_MULTIPLE", "BALANCE_CHECK", "GROUP_FUND", "CLARIFY"] = Field(
        description="The primary action the user wants to take."
    )
    
    transactions: List[TransactionDetail] = Field(
        default=[],
        description="List of all extracted transactions."
    )

"""
End-Point function to be called by backend 
Boolean flag to handle group fund additions that are ambiguous
"""
def parse_text(meta_data: dict, group_roster: List[str]) -> dict:
    client = genai.Client()

    # extract properties directly from raw chat event
    sender_user = meta_data.get("from", {})
    # Currrently if no username is present it will default to the telegramID
    sender = f"@{sender_user.get('username')}" if sender_user.get("username") else str(sender_user.get("id", "CLARIFY"))

    # get the type of chat opened, to understand intent better
    chat = meta_data.get("chat", {})
    chat_type = chat.get("type")    # private or group etc

    text_chat = meta_data.get("text", None)
    
    roster_str = ", ".join(group_roster) if group_roster else "CLARIFY"

    prompt = f"""
    Analyze the following user request from a South African chat interface and extract payment details:
    
    User Request: "{text_chat}"
    
    Guidelines:
    1. The request may be written in local South African languages or slang (isiXhosa, Zulu, Afrikaans, English).
    2. Default 'source_currency' to a flag 'DEFAULT' if the currency is not explicit - e.g. bucks. This default allows the backend to use the wallet's actual currency type
    3. Determine 'conversion_type' accurately based on whether they fix the send or receive side currency values.
    4. Normalize all currencies to standard 3-letter ISO codes.
    5. EXPENSE SPLITTING & DIRECT DEBT RECORDING (GROUP_FUND): 
       If the user wants to split an expense, a bill, or records that they owe someone, or someone owes them (e.g., 'split R300 dinner', 'I paid R300 for drinks', 'I owe Sean R50', 'Sean owes me R50', 'Sizwe skuld my R100'):
       
       - Set the primary 'intent' to 'GROUP_FUND' (do NOT use PAYMENT_MULTIPLE).
       
       - PATHWAY A: GROUP BILL SPLITTING (e.g., 'split R300 dinner', 'I paid R300'):
         * Count the total number of people involved. This is the number of members in [AVAILABLE_GROUP_ROSTER] PLUS the [SENDER_IDENTIFIER] (e.g. if roster has 3 people, total members is 4).
         * Divide the total amount equally among all members (e.g., R300 split among 4 total members is R75 each).
         * Create a TransactionDetail for each roster member (excluding the [SENDER_IDENTIFIER] themselves). For each, set [1]:
           - 'debtor': that roster member's identifier (signifying they owe money) [1].
           - 'creditor': the [SENDER_IDENTIFIER] (signifying they are owed) [1].
           - 'amount': the split share (e.g., 75.00) [1].
           - 'recipients': include that roster member's identifier in the list [1].
       
       - PATHWAY B: DIRECT DEBTS & IOUs (e.g., 'I owe Sean R50', 'Sean owes me R50'):
         * Create a single TransactionDetail in the list [1].
         * Dynamically determine who is the 'debtor' (who owes) and who is the 'creditor' (who is owed) [1]:
           - If "I owe Sean R50": 'debtor' is the [SENDER_IDENTIFIER], 'creditor' is Sean [1].
           - If "Sean owes me R50": 'debtor' is Sean, 'creditor' is the [SENDER_IDENTIFIER] [1].
           - If "Sizwe skuld Danny R100": 'debtor' is Sizwe, 'creditor' is Danny [1].
         * Set the parsed amount in 'amount' [1].
         * Add the person getting paid (the creditor) to the 'recipients' list [1].


    Additional Guidelines:
    1. If the intent is known, such as PAYMENT etc. but does not know the recipient 

    ENVIRONMENT CONTEXT:
    - [SENDER_IDENTIFIER]: "{sender}"
    - [AVAILABLE_GROUP_ROSTER]: [{roster_str}]
    - [CHAT_TYPE]: "{chat_type}"

    GUIDELINES FOR DYNAMIC RESOLUTION:
    1. If the user refers to the receiver contextually using pronouns ('you', 'wena', 'him', 'her', 'hom', 'yena'), and this is a private 1-1 chat, assume the recipient is the chat endpoint.
    2. MATCHING RULE: If the user types a plain name without an explicit tag (e.g., 'Send Sean 50 bucks' or 'Betaal vir Sizwe R100'), look at [AVAILABLE_GROUP_ROSTER]. 
       If a roster item contains or matches that name (e.g., 'Sean' matches '@Sean_99' or '+27821234567'), extract that matched roster identifier value instead of the plain name.
    3. If the user is in a group chat and says 'everyone' or 'all of them', extract all identifiers from [AVAILABLE_GROUP_ROSTER] (excluding the sender).
    4. FALLBACK RULE: If the name does not match any entry in [AVAILABLE_GROUP_ROSTER], extract the literal plain name string directly so the backend can search manually.
    """

    # generate response
    try:
        # Requesting content using Gemini structured output config
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            # force response in JSON 
            config={
                'response_mime_type': 'application/json',
                'response_schema': PaymentIntent,
            },
        )
        
        # return a the python dict
        return response.parsed.model_dump()

    except Exception as e:
        print(e)
        # provide a fallback to possibly be handled by backend?
        return {
            "intent": "CLARIFY",
            "transactions": []
        }