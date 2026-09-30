import streamlit as st


def footer_home():
    st.markdown("""
        <div style="margin-top:2rem; text-align:center;">
        <p style="font-weight:bold; color:white; opacity:0.65; font-size:0.85rem;">
            SnapAttend — AI-powered attendance
        </p>
        </div>
                """, unsafe_allow_html=True)


def footer_dashboard():
    st.markdown("""
        <div style="margin-top:2rem; text-align:center;">
        <p style="font-weight:bold; color:black; opacity:0.55; font-size:0.85rem;">
            SnapAttend — AI-powered attendance
        </p>
        </div>
                """, unsafe_allow_html=True)
