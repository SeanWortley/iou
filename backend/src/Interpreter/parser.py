import os
from google import genai
from pydantic import BaseModel, Field
from typing import Optional, Literal, List

""""""
# FOR MY TESTING:
from fastapi import FastAPI, HTTPException
app = FastAPI()

class UserRequest(BaseModel):
    text: str

# expose endpoint
@app.post("/parse")
def parse_endpoint(request: UserRequest):
    return parse_text(request.text)
""""""

"""
Defines the layout of an individual transaction

    - Container to hold information of a single transaction
    - Can be placed in a shared List for PAYMENT_MULTIPLE
"""
class TransactionDetail(BaseModel):
    recipient: Optional[str] = Field(
        None, description="The name, handle, or identifier of the receiver."
    )

    amount: Optional[float] = Field(
        None, description="The exact numerical amount to be sent."
    )

    source_currency: str = Field(
        default="ZAR", 
        description="The currency of the sender initiating the payment. Standardised to 3-letter ISO. Defaults to ZAR"
    )

    target_currency: str = Field(
        default="ZAR",
        description="The currency the receiver must get. Standardised to 3-letter ISO. Defaults to ZAR if implicit"
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
    intent: Literal["PAYMENT", "PAYMENT_MULTIPLE", "BALANCE_CHECK", "UNKNOWN"] = Field(
        description="The primary action the user wants to take."
    )
    
    transactions: List[TransactionDetail] = Field(
        default=[],
        description="List of all extracted transactions; list is ONLY populated IF payment/multiple"
    )

"""
Function to be called by the bot

    Return: JSON / Python Dict of user intent
"""
def parse_text(usr_text: str) -> dict:
    client = genai.Client()

    prompt = f"""
    Analyze the following user request from a South African chat interface and extract payment details:
    
    User Request: "{usr_text}"
    
    Guidelines:
    1. The request may be written in local South African languages or slang. (isiXhosa, Zulu, Afrikaans, English)
    2. Default 'source_currency' to 'ZAR' unless explicitly stated otherwise.
    3. Determine the 'conversion_type':
       - If the user dictates a fixed local amount to be converted (e.g., 'Send R200 in USD', 'Convert R500 to Dollars for Mom'), set conversion_type to 'FIXED_SEND'. The specified amount belongs to the source_currency.
       - If the user dictates a specific foreign target amount (e.g., 'Send John exactly 50 dollars', 'He needs 100 USD'), set conversion_type to 'FIXED_RECEIVE'. The specified amount belongs to the target_currency.
       - If no currency exchange is happening, set conversion_type to 'NONE'.
    4. Normalize all currencies to standard 3-letter ISO codes (e.g., 'dollars' or '$' -> 'USD', 'rands' or 'R' -> 'ZAR').
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
        # provide a fallback to possibly be handled by backend?
        return {
            "intent": "UNKNOWN",
            "transactions": []
        }