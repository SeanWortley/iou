import os
from google import genai
from pydantic import BaseModel, Field
from typing import Optional, Literal, List, Dict, Any
from fastapi import FastAPI, HTTPException

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
        )
    )
    amount: Optional[float] = Field(
        None, description="The exact numerical amount to be sent."
    )
    source_currency: str = Field(
        default="DEFAULT", 
        description="The currency of the sender initiating the payment. Standardised to 3-letter ISO. Defaults to a flag 'DEFAULT' if not explicitly given."
    )
    target_currency: str = Field(
        default="DEFAULT",
        description="The currency the receiver must get. Standardised to 3-letter ISO. Defaults to a flag 'DEFAULT' if not explicitly given."
    )
    conversion_type: Literal["NONE", "FIXED_SEND", "FIXED_RECEIVE"] = Field(
        default="NONE",
        description=(
            "Set to FIXED_SEND if the user specifies a fixed amount in their local currency to convert from"
            "Set to FIXED_RECEIVE if the user explicitly wants the recipient to get a exact fixed amount in a foreign currency"
            "Set to NONE if both currencies are identical"
        )
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